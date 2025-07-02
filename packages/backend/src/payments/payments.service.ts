import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import Stripe from 'stripe';

@Injectable()
export class PaymentsService {
  private stripe: Stripe | null = null;
  private readonly logger = new Logger(PaymentsService.name);
  private readonly isDevelopment = process.env.NODE_ENV !== 'production';

  constructor(
    private prisma: PrismaService,
    private creditsService: CreditsService,
  ) {
    // Stripe 초기화 시도
    try {
      if (process.env.STRIPE_SECRET_KEY) {
        this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
          apiVersion: (process.env.STRIPE_API_VERSION as any) || '2024-12-18.acacia',
        });
        this.logger.log('Stripe initialized successfully');
      } else {
        this.logger.warn('Stripe not configured. Using mock payment system for development.');
      }
    } catch (error) {
      this.logger.error('Failed to initialize Stripe:', error);
    }
  }

  // 결제 세션 생성
  async createPaymentSession(userId: number, credits: number) {
    try {
      // 가격 계산 (100 크레딧 = $1)
      const amountInCents = Math.ceil((credits / 100) * 100);

      // 사용자 정보 조회
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new Error('사용자를 찾을 수 없습니다.');
      }

      // Stripe가 없는 경우 무조건 Mock 처리 (개발용)
      if (!this.stripe) {
        this.logger.log('Stripe not configured, using mock payment system');
        return this.createMockPaymentSession(userId, credits, amountInCents, user.email);
      }

      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `${credits} 크레딧 구매`,
                description: `약 ${Math.ceil(credits / 10)}페이지 분석 가능`,
              },
              unit_amount: amountInCents,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/cancel`,
        metadata: {
          userId: userId.toString(),
          credits: credits.toString(),
        },
        customer_email: user.email,
      });

             // 결제 기록 생성
       await this.prisma.payment.create({
         data: {
           userId,
           stripeSessionId: session.id,
           amount: amountInCents, // 센트 단위로 저장
           currency: 'USD',
           status: 'pending',
           type: 'credits',
           description: `${credits} 크레딧 구매`,
           creditsGranted: credits,
         },
       });

      return {
        sessionId: session.id,
        url: session.url,
        amount: amountInCents / 100,
        credits,
      };
    } catch (error) {
      this.logger.error('Failed to create payment session:', error);
      throw new Error('결제 세션 생성에 실패했습니다.');
    }
  }

  // 개발용 Mock 결제 세션
  private async createMockPaymentSession(userId: number, credits: number, amountInCents: number, email: string) {
    const mockSessionId = `mock_session_${Date.now()}_${userId}`;
    
         // Mock 결제 기록 생성
     await this.prisma.payment.create({
       data: {
         userId,
         stripeSessionId: mockSessionId,
         amount: amountInCents, // 센트 단위로 저장
         currency: 'USD',
         status: 'succeeded', // Mock에서는 즉시 성공 처리
         type: 'credits',
         description: `${credits} 크레딧 구매 (개발 테스트)`,
         creditsGranted: credits,
       },
     });

    // Mock에서는 즉시 크레딧 추가
    await this.creditsService.addCredits(userId, credits, mockSessionId);

    this.logger.log(`Mock payment completed for user ${userId}: ${credits} credits added`);

    return {
      sessionId: mockSessionId,
      url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/success?session_id=${mockSessionId}`,
      amount: amountInCents / 100,
      credits,
      isMock: true,
    };
  }

  // Stripe 웹훅 처리
  async handleStripeWebhook(payload: Buffer, signature: string) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!webhookSecret || !this.stripe) {
      this.logger.error('Stripe webhook secret not configured or Stripe not initialized');
      throw new Error('Webhook secret not configured');
    }

    try {
      // Stripe 웹훅 서명 검증
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret,
      );

      this.logger.log(`Processing webhook event: ${event.type}`);

      switch (event.type) {
        case 'checkout.session.completed':
          await this.handlePaymentSuccess(event.data.object as Stripe.Checkout.Session);
          break;
        case 'checkout.session.expired':
          await this.handlePaymentFailed(event.data.object as Stripe.Checkout.Session);
          break;
        case 'payment_intent.payment_failed':
          await this.handlePaymentFailed(event.data.object as any);
          break;
        default:
          this.logger.log(`Unhandled event type: ${event.type}`);
      }

      return { received: true };
    } catch (error) {
      this.logger.error('Webhook processing failed:', error);
      throw new Error('웹훅 처리에 실패했습니다.');
    }
  }

  // 결제 성공 처리
  private async handlePaymentSuccess(session: Stripe.Checkout.Session) {
    try {
      const userId = parseInt(session.client_reference_id || '0');
      const credits = parseInt(session.metadata?.credits || '0');

      if (!userId || !credits) {
        this.logger.error('Invalid payment data in webhook:', { userId, credits });
        return;
      }

      // 결제 상태 업데이트
      const payment = await this.prisma.payment.update({
        where: { stripeSessionId: session.id },
        data: { status: 'completed' },
      });

      // 크레딧 추가
      await this.creditsService.addCredits(userId, credits, payment.id);

      this.logger.log(`Payment completed for user ${userId}: +${credits} credits`);
      
      // 선택사항: 이메일 알림 발송
      // await this.sendPaymentConfirmationEmail(userId, credits);
      
    } catch (error) {
      this.logger.error('Failed to process payment success:', error);
      // 실패한 경우 다시 시도하거나 관리자에게 알림
    }
  }

  // 결제 실패 처리
  private async handlePaymentFailed(session: any) {
    try {
      const sessionId = session.id;
      
      // 결제 상태를 실패로 업데이트
      await this.prisma.payment.updateMany({
        where: { stripeSessionId: sessionId },
        data: { status: 'failed' },
      });

      this.logger.log(`Payment failed for session: ${sessionId}`);
    } catch (error) {
      this.logger.error('Failed to process payment failure:', error);
    }
  }

  // 결제 내역 조회
  async getPaymentHistory(userId: number) {
    const payments = await this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return payments.map(payment => ({
      id: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      type: payment.type,
      description: payment.description,
      creditsGranted: payment.creditsGranted,
      createdAt: payment.createdAt,
    }));
  }

  // 결제 세션 상태 확인
  async checkPaymentStatus(sessionId: string) {
    try {
      // Mock 세션인 경우
      if (sessionId.startsWith('mock_session_')) {
        const payment = await this.prisma.payment.findUnique({
          where: { stripeSessionId: sessionId },
        });
        
        return {
          stripeStatus: 'paid',
          dbStatus: payment?.status,
          amount: payment?.amount,
          credits: payment?.creditsGranted,
          isMock: true,
        };
      }

      if (!this.stripe) {
        throw new Error('Stripe not configured');
      }

      const session = await this.stripe.checkout.sessions.retrieve(sessionId);
      
      // 데이터베이스에서도 확인
      const payment = await this.prisma.payment.findUnique({
        where: { stripeSessionId: sessionId },
      });

      return {
        stripeStatus: session.payment_status,
        dbStatus: payment?.status,
        amount: payment?.amount,
        credits: payment?.creditsGranted,
      };
    } catch (error) {
      this.logger.error('Failed to check payment status:', error);
      throw new Error('결제 상태 확인에 실패했습니다.');
    }
  }
} 