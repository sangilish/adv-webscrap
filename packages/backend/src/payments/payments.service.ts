import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private stripe: Stripe;
  private readonly isDevelopment = process.env.NODE_ENV !== 'production';

  constructor(
    private configService: ConfigService,
    private prismaService: PrismaService,
    private creditsService: CreditsService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY') || 'sk_test_YOUR_STRIPE_SECRET_KEY_HERE';
    this.stripe = new Stripe(stripeSecretKey, {
      apiVersion: '2024-12-18.acacia',
    });
    this.logger.log('Stripe initialized successfully');
  }

  // Embedded Checkout 세션 생성 (Reference 코드 방식 적용)
  async createPaymentSession(
    userId: number, 
    credits: number, 
    amount?: number, 
    paymentType: 'one-time' | 'subscription' = 'one-time'
  ) {
    try {
      // 가격 계산
      let amountInCents: number;
      let description: string;
      let mode: 'payment' | 'subscription' = 'payment';

      if (paymentType === 'subscription') {
        // 구독: 월 500페이지 $70
        amountInCents = 7000; // $70 in cents
        description = '월간 구독 - 500페이지 분석';
        mode = 'subscription';
      } else {
        // 일회성: 사용자가 제공한 amount 사용, 없으면 기존 방식
        if (amount) {
          amountInCents = Math.ceil(amount * 100);
        } else {
          amountInCents = Math.ceil((credits / 100) * 100); // 기존 방식: 100 크레딧 = $1
        }
        description = `${credits} 크레딧 구매 - 약 ${Math.ceil(credits / 10)}페이지 분석`;
      }

      // 사용자 정보 조회
      const user = await this.prismaService.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new Error('사용자를 찾을 수 없습니다.');
      }

      // Stripe가 없는 경우 무조건 Mock 처리 (개발용)
      if (!this.stripe) {
        this.logger.log('Stripe not configured, using mock payment system');
        return this.createMockPaymentSession(userId, credits, amountInCents, user.email, paymentType);
      }

      let sessionConfig: any = {
        ui_mode: 'embedded',
        return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/return?session_id={CHECKOUT_SESSION_ID}`,
        metadata: {
          userId: userId.toString(),
          credits: credits.toString(),
          paymentType,
        },
        customer_email: user.email,
      };

      if (paymentType === 'subscription') {
        // 구독 모드
        sessionConfig.mode = 'subscription';
        sessionConfig.line_items = [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: '월간 구독 플랜',
                description: '월 500페이지 분석 가능',
              },
              unit_amount: amountInCents,
              recurring: {
                interval: 'month',
              },
            },
            quantity: 1,
          },
        ];
      } else {
        // 일회성 결제 모드
        sessionConfig.mode = 'payment';
        sessionConfig.line_items = [
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
        ];
      }

      // Embedded Checkout 세션 생성
      const session = await this.stripe.checkout.sessions.create(sessionConfig);

      // 결제 기록 생성
      await this.prismaService.payment.create({
        data: {
          userId,
          stripeSessionId: session.id,
          amount: amountInCents, // 센트 단위로 저장
          currency: 'USD',
          status: 'pending',
          type: paymentType === 'subscription' ? 'subscription' : 'credits',
          description,
          creditsGranted: credits,
        },
      });

      return {
        sessionId: session.id,
        clientSecret: session.client_secret,
        amount: amountInCents / 100,
        credits,
        paymentType,
      };
    } catch (error) {
      this.logger.error('Failed to create payment session:', error);
      throw new Error('결제 세션 생성에 실패했습니다.');
    }
  }

  // 개발용 Mock 결제 세션
  private async createMockPaymentSession(
    userId: number, 
    credits: number, 
    amountInCents: number, 
    email: string, 
    paymentType: 'one-time' | 'subscription' = 'one-time'
  ) {
    const mockSessionId = `mock_session_${Date.now()}_${userId}`;
    
    let description: string;
    let type: string;

    if (paymentType === 'subscription') {
      description = '월간 구독 - 500페이지 분석 (개발 테스트)';
      type = 'subscription';
    } else {
      description = `${credits} 크레딧 구매 (개발 테스트)`;
      type = 'credits';
    }
    
    // Mock 결제 기록 생성
    await this.prismaService.payment.create({
      data: {
        userId,
        stripeSessionId: mockSessionId,
        amount: amountInCents, // 센트 단위로 저장
        currency: 'USD',
        status: 'succeeded', // Mock에서는 즉시 성공 처리
        type,
        description,
        creditsGranted: credits,
      },
    });

    // Mock에서는 즉시 크레딧 추가
    await this.creditsService.addCredits(userId, credits, mockSessionId);

    this.logger.log(`Mock payment completed for user ${userId}: ${credits} credits added (${paymentType})`);

    return {
      sessionId: mockSessionId,
      clientSecret: `mock_client_secret_${mockSessionId}`,
      amount: amountInCents / 100,
      credits,
      paymentType,
      isMock: true,
    };
  }

  // 결제 상태 확인 (Reference의 session-status 방식)
  async getSessionStatus(sessionId: string) {
    try {
      if (!this.stripe) {
        // Mock 세션 처리
        if (sessionId.startsWith('mock_session_')) {
          const payment = await this.prismaService.payment.findFirst({
            where: { stripeSessionId: sessionId },
          });
          
          return {
            status: payment?.status === 'succeeded' ? 'complete' : 'open',
            customer_email: 'mock@example.com',
            payment_status: payment?.status || 'pending',
          };
        }
        throw new Error('Stripe not configured');
      }

      const session = await this.stripe.checkout.sessions.retrieve(sessionId);
      
      // 결제가 완료된 경우 크레딧 자동 추가 (웹훅 대신)
      if (session.payment_status === 'paid') {
        await this.processCompletedPayment(sessionId, session);
      }
      
      return {
        status: session.status,
        customer_email: session.customer_details?.email || '',
        payment_status: session.payment_status,
      };
    } catch (error) {
      this.logger.error('Failed to get session status:', error);
      throw new Error('세션 상태 조회에 실패했습니다.');
    }
  }

  // 완료된 결제 처리 (웹훅 대신 사용)
  private async processCompletedPayment(sessionId: string, session: Stripe.Checkout.Session) {
    try {
      // 이미 처리된 결제인지 확인
      const existingPayment = await this.prismaService.payment.findFirst({
        where: { 
          stripeSessionId: sessionId,
          status: 'succeeded'
        },
      });

      if (existingPayment) {
        this.logger.log(`Payment already processed: ${sessionId}`);
        return;
      }

      const userId = parseInt(session.metadata?.userId || '0');
      const credits = parseInt(session.metadata?.credits || '0');

      if (!userId || !credits) {
        this.logger.error('Invalid payment data:', { userId, credits, sessionId });
        return;
      }

      // 결제 상태 업데이트
      await this.prismaService.payment.updateMany({
        where: { stripeSessionId: sessionId },
        data: { status: 'succeeded' },
      });

      // 크레딧 추가
      await this.creditsService.addCredits(userId, credits, sessionId);

      this.logger.log(`Payment processed for user ${userId}: +${credits} credits (session: ${sessionId})`);
      
    } catch (error) {
      this.logger.error('Failed to process completed payment:', error);
    }
  }

  // Stripe 웹훅 처리
  async handleStripeWebhook(payload: Buffer, signature: string) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!webhookSecret || !this.stripe) {
      this.logger.error('Stripe webhook secret not configured or Stripe not initialized');
      throw new Error('Webhook secret not configured');
    }

    try {
      // Stripe 웹훅 서명 검증 (null 체크 추가)
      if (!this.stripe) {
        throw new Error('Stripe not initialized');
      }
      
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
      const userId = parseInt(session.metadata?.userId || '0');
      const credits = parseInt(session.metadata?.credits || '0');

      if (!userId || !credits) {
        this.logger.error('Invalid payment data in webhook:', { userId, credits });
        return;
      }

      // 결제 상태 업데이트
      const payment = await this.prismaService.payment.update({
        where: { stripeSessionId: session.id },
        data: { status: 'succeeded' },
      });

      // 크레딧 추가
      await this.creditsService.addCredits(userId, credits, session.id);

      this.logger.log(`Payment completed for user ${userId}: +${credits} credits`);
      
    } catch (error) {
      this.logger.error('Failed to handle payment success:', error);
    }
  }

  // 결제 실패 처리
  private async handlePaymentFailed(session: any) {
    try {
      const sessionId = session.id;
      
      // 결제 상태 업데이트
      await this.prismaService.payment.update({
        where: { stripeSessionId: sessionId },
        data: { status: 'failed' },
      });

      this.logger.log(`Payment failed for session: ${sessionId}`);
    } catch (error) {
      this.logger.error('Failed to handle payment failure:', error);
    }
  }

  // 결제 내역 조회
  async getPaymentHistory(userId: number) {
    return this.prismaService.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // 결제 상태 확인 (이전 방식과 호환성 유지)
  async checkPaymentStatus(sessionId: string) {
    try {
      if (!this.stripe) {
        // Mock 결제 처리
        const payment = await this.prismaService.payment.findFirst({
          where: { stripeSessionId: sessionId },
        });
        
        return {
          status: payment?.status || 'pending',
          amount: payment?.amount || 0,
          credits: payment?.creditsGranted || 0,
        };
      }

      if (!this.stripe) {
        throw new Error('Stripe not initialized');
      }

      const session = await this.stripe.checkout.sessions.retrieve(sessionId);
      
      const payment = await this.prismaService.payment.findFirst({
        where: { stripeSessionId: sessionId },
      });

      return {
        status: session.payment_status || 'pending',
        amount: (session.amount_total || 0) / 100,
        credits: payment?.creditsGranted || 0,
      };
    } catch (error) {
      this.logger.error('Failed to check payment status:', error);
      throw new Error('결제 상태 확인에 실패했습니다.');
    }
  }

  // 테스트용 크레딧 추가
  async addTestCredits(userId: number, credits: number = 1000) {
    if (!this.isDevelopment) {
      throw new Error('테스트 크레딧은 개발 환경에서만 사용 가능합니다.');
    }

    const testSessionId = `test_${Date.now()}_${userId}`;
    
    // 테스트 결제 기록 생성
    await this.prismaService.payment.create({
      data: {
        userId,
        stripeSessionId: testSessionId,
        amount: 0,
        currency: 'USD',
        status: 'succeeded',
        type: 'credits',
        description: `테스트 크레딧 ${credits}개 추가`,
        creditsGranted: credits,
      },
    });

    // 크레딧 추가
    await this.creditsService.addCredits(userId, credits, testSessionId);

    this.logger.log(`Test credits added for user ${userId}: +${credits} credits`);
    
    return {
      success: true,
      credits,
      message: `${credits} 테스트 크레딧이 추가되었습니다.`,
    };
  }

  // 수동 결제 처리 (웹훅 대신)
  async manualProcessPayment(sessionId: string, userId: number) {
    try {
      if (!this.stripe) {
        throw new Error('Stripe not configured');
      }

      // Stripe에서 세션 정보 조회
      const session = await this.stripe.checkout.sessions.retrieve(sessionId);
      
      if (session.payment_status !== 'paid') {
        throw new Error('결제가 완료되지 않았습니다.');
      }

      // 세션의 userId와 요청한 userId가 일치하는지 확인
      const sessionUserId = parseInt(session.metadata?.userId || '0');
      if (sessionUserId !== userId) {
        throw new Error('권한이 없습니다.');
      }

      // 결제 처리
      await this.processCompletedPayment(sessionId, session);

      // 업데이트된 크레딧 조회
      const user = await this.prismaService.user.findUnique({
        where: { id: userId },
        select: { credits: true },
      });

      return {
        success: true,
        message: '결제가 성공적으로 처리되었습니다.',
        credits: user?.credits || 0,
      };
    } catch (error) {
      this.logger.error('Manual payment processing failed:', error);
      throw error;
    }
  }
} 