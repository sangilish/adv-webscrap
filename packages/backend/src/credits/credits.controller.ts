import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { CreditsService } from './credits.service';
import { PurchaseCreditsDto } from './dto/credit-transaction.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('credits')
@UseGuards(JwtAuthGuard)
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @Get('balance')
  async getCreditBalance(@Request() req) {
    return this.creditsService.getCreditBalance(req.user.id);
  }

  @Post('purchase/prepare')
  async preparePurchase(@Body() purchaseDto: PurchaseCreditsDto) {
    return this.creditsService.prepareCreditPurchase(purchaseDto);
  }

  // 테스트용 크레딧 직접 추가
  @Post('test/add')
  async addTestCredits(@Request() req, @Body() body: { credits: number }) {
    const credits = body.credits || 500;
    await this.creditsService.addCredits(req.user.id, credits, 'test_payment');
    
    // 업데이트된 잔액 반환
    return this.creditsService.getCreditBalance(req.user.id);
  }

  @Get('pricing')
  async getPricing() {
    return {
      rates: {
        creditsPerDollar: 100,
        creditsPerPage: 10,
        pagesPerDollar: 10,
      },
      packages: [
        {
          name: 'Basic',
          credits: 500,
          price: 5.00,
          pages: 50,
          popular: false,
        },
        {
          name: 'Standard',
          credits: 1200,
          price: 10.00,
          pages: 120,
          popular: true,
          bonus: 200, // 추가 200크레딧 보너스
        },
        {
          name: 'Premium',
          credits: 2500,
          price: 20.00,
          pages: 250,
          popular: false,
          bonus: 500, // 추가 500크레딧 보너스
        },
        {
          name: 'Enterprise',
          credits: 5500,
          price: 40.00,
          pages: 550,
          popular: false,
          bonus: 1000, // 추가 1000크레딧 보너스
        },
      ],
    };
  }
} 