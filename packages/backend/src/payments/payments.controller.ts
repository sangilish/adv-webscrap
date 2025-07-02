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
  Logger
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

interface CreatePaymentDto {
  credits: number;
}

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  // 결제 세션 생성
  @Post('create-session')
  @UseGuards(JwtAuthGuard)
  async createPaymentSession(
    @Request() req,
    @Body() createPaymentDto: CreatePaymentDto,
  ) {
    try {
      this.logger.log(`Create payment session request: ${JSON.stringify(createPaymentDto)}`);
      this.logger.log(`User info: ${JSON.stringify(req.user)}`);
      
      const { credits } = createPaymentDto;
      
      if (!credits || credits < 100) {
        throw new Error('최소 100크레딧부터 구매 가능합니다.');
      }

      const result = await this.paymentsService.createPaymentSession(req.user.id, credits);
      this.logger.log(`Payment session created successfully: ${JSON.stringify(result)}`);
      
      return result;
    } catch (error) {
      this.logger.error('Failed to create payment session:', error);
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

  // 결제 상태 확인
  @Get('status/:sessionId')
  @UseGuards(JwtAuthGuard)
  async checkPaymentStatus(@Param('sessionId') sessionId: string) {
    return this.paymentsService.checkPaymentStatus(sessionId);
  }

  // 테스트용 크레딧 직접 추가
  @Post('test-add-credits')
  @UseGuards(JwtAuthGuard)
  async testAddCredits(@Request() req, @Body() body: { credits: number }) {
    try {
      this.logger.log(`Test add credits: ${body.credits} for user ${req.user.id}`);
      
      // 직접 크레딧 추가
      const user = await this.paymentsService['prisma'].user.findUnique({
        where: { id: req.user.id },
      });

      if (!user) {
        throw new Error('사용자를 찾을 수 없습니다.');
      }

      await this.paymentsService['prisma'].user.update({
        where: { id: req.user.id },
        data: {
          credits: user.credits + body.credits,
          totalCreditsEarned: user.totalCreditsEarned + body.credits,
        },
      });

      return { success: true, message: `${body.credits} 크레딧이 추가되었습니다.` };
    } catch (error) {
      this.logger.error('Failed to add test credits:', error);
      throw error;
    }
  }
} 