import { 
  Controller, 
  Post, 
  Body, 
  UseGuards, 
  Request, 
  Get, 
  Param,
  RawBodyRequest,
  Req,
  Headers,
  HttpCode,
  Logger,
  Query
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

interface CreatePaymentDto {
  credits: number;
  amount?: number;
  paymentType?: 'one-time' | 'subscription';
}

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  // 결제 세션 생성 (Embedded Checkout)
  @Post('create-session')
  @UseGuards(JwtAuthGuard)
  async createPaymentSession(
    @Request() req,
    @Body() createPaymentDto: CreatePaymentDto,
  ) {
    try {
      this.logger.log(`Create payment session request: ${JSON.stringify(createPaymentDto)}`);
      this.logger.log(`User info: ${JSON.stringify(req.user)}`);
      
      const { credits, amount, paymentType = 'one-time' } = createPaymentDto;
      
      if (!credits || credits < 10) {
        throw new Error('최소 10크레딧부터 구매 가능합니다.');
      }

      const result = await this.paymentsService.createPaymentSession(
        req.user.id, 
        credits, 
        amount, 
        paymentType
      );
      this.logger.log(`Payment session created successfully: ${JSON.stringify(result)}`);
      
      return result;
    } catch (error) {
      this.logger.error('Failed to create payment session:', error);
      throw error;
    }
  }

  // Reference 코드의 session-status 엔드포인트
  @Get('session-status')
  async getSessionStatus(@Query('session_id') sessionId: string) {
    try {
      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      const result = await this.paymentsService.getSessionStatus(sessionId);
      this.logger.log(`Session status retrieved: ${JSON.stringify(result)}`);
      
      return result;
    } catch (error) {
      this.logger.error('Failed to get session status:', error);
      throw error;
    }
  }

  // Stripe 웹훅 엔드포인트
  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    try {
      const payload = req.rawBody;
      
      if (!payload) {
        throw new Error('No payload received');
      }

      const result = await this.paymentsService.handleStripeWebhook(
        payload,
        signature,
      );

      this.logger.log('Webhook processed successfully');
      return result;
    } catch (error) {
      this.logger.error('Webhook processing failed:', error);
      throw error;
    }
  }

  // 결제 내역 조회
  @Get('history')
  @UseGuards(JwtAuthGuard)
  async getPaymentHistory(@Request() req) {
    return this.paymentsService.getPaymentHistory(req.user.id);
  }

  // 결제 상태 확인 (이전 방식과 호환성 유지)
  @Get('status/:sessionId')
  @UseGuards(JwtAuthGuard)
  async checkPaymentStatus(@Param('sessionId') sessionId: string) {
    return this.paymentsService.checkPaymentStatus(sessionId);
  }

  // 테스트용 크레딧 직접 추가 (개선된 버전)
  @Post('test-add-credits')
  @UseGuards(JwtAuthGuard)
  async testAddCredits(@Request() req, @Body() body: { credits?: number }) {
    try {
      const credits = body.credits || 1000;
      this.logger.log(`Test add credits: ${credits} for user ${req.user.id}`);
      
      const result = await this.paymentsService.addTestCredits(req.user.id, credits);
      
      return result;
    } catch (error) {
      this.logger.error('Failed to add test credits:', error);
      throw error;
    }
  }

  // 수동 결제 완료 처리 (웹훅 대신)
  @Post('process-payment')
  @UseGuards(JwtAuthGuard)
  async processPayment(@Request() req, @Body() body: { sessionId: string }) {
    try {
      const { sessionId } = body;
      
      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      this.logger.log(`Manual payment processing for session: ${sessionId}`);
      
      const result = await this.paymentsService.manualProcessPayment(sessionId, req.user.id);
      
      return result;
    } catch (error) {
      this.logger.error('Failed to process payment manually:', error);
      throw error;
    }
  }

  // 디버깅용: 사용자의 결제 내역 상세 조회
  @Get('debug-history')
  @UseGuards(JwtAuthGuard)
  async getDebugPaymentHistory(@Request() req) {
    try {
      const payments = await this.paymentsService.getPaymentHistory(req.user.id);
      
      // 더 자세한 정보 로깅
      this.logger.log(`Payment history for user ${req.user.id}:`, JSON.stringify(payments, null, 2));
      
      return {
        userId: req.user.id,
        totalPayments: payments.length,
        payments: payments.map(p => ({
          id: p.id,
          amount: p.amount,
          amountInDollars: p.amount / 100,
          currency: p.currency,
          creditsGranted: p.creditsGranted,
          status: p.status,
          type: p.type,
          description: p.description,
          stripeSessionId: p.stripeSessionId,
          createdAt: p.createdAt
        }))
      };
    } catch (error) {
      this.logger.error('Failed to get debug payment history:', error);
      throw error;
    }
  }
} 