import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCreditTransactionDto, CreditBalanceDto, PurchaseCreditsDto } from './dto/credit-transaction.dto';

@Injectable()
export class CreditsService {
  constructor(private prisma: PrismaService) {}

  // 사용자 크레딧 잔액 조회
  async getCreditBalance(userId: number): Promise<CreditBalanceDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    // 최근 거래 내역 10개 조회
    const recentTransactions = await this.prisma.creditTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    return {
      credits: user.credits,
      totalCreditsEarned: user.totalCreditsEarned,
      totalCreditsUsed: user.totalCreditsUsed,
      recentTransactions: recentTransactions.map(tx => ({
        id: tx.id,
        type: tx.type,
        amount: tx.amount,
        balanceAfter: tx.balanceAfter,
        description: tx.description,
        createdAt: tx.createdAt,
      })),
    };
  }

  // 크레딧 사용 (페이지 크롤링 시)
  async useCredits(userId: number, creditsToUse: number, analysisId?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    if (user.credits < creditsToUse) {
      throw new BadRequestException('크레딧이 부족합니다.');
    }

    // 트랜잭션으로 크레딧 차감 및 거래 내역 생성
    await this.prisma.$transaction(async (tx) => {
      // 사용자 크레딧 차감
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          credits: user.credits - creditsToUse,
          totalCreditsUsed: user.totalCreditsUsed + creditsToUse,
        },
      });

      // 거래 내역 생성
      await tx.creditTransaction.create({
        data: {
          userId,
          type: 'usage',
          amount: -creditsToUse,
          balanceAfter: updatedUser.credits,
          description: `페이지 크롤링 (${creditsToUse}크레딧 사용)`,
          analysisId,
        },
      });

      // Analysis 업데이트 (분석에서 사용된 크레딧 기록)
      if (analysisId) {
        await tx.analysis.update({
          where: { id: analysisId },
          data: { creditsUsed: creditsToUse },
        });
      }
    });
  }

  // 크레딧 추가 (결제 완료 시)
  async addCredits(userId: number, creditsToAdd: number, paymentId?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    // 트랜잭션으로 크레딧 추가 및 거래 내역 생성
    await this.prisma.$transaction(async (tx) => {
      // 사용자 크레딧 추가
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          credits: user.credits + creditsToAdd,
          totalCreditsEarned: user.totalCreditsEarned + creditsToAdd,
        },
      });

      // 거래 내역 생성
      await tx.creditTransaction.create({
        data: {
          userId,
          type: 'purchase',
          amount: creditsToAdd,
          balanceAfter: updatedUser.credits,
          description: `크레딧 구매 (${creditsToAdd}크레딧 추가)`,
          paymentId,
        },
      });
    });
  }

  // 크레딧 구매 준비 (결제 금액 계산)
  async prepareCreditPurchase(purchaseDto: PurchaseCreditsDto) {
    const { credits } = purchaseDto;
    
    // 100 크레딧 = $1 = 100센트
    const amountInCents = Math.ceil((credits / 100) * 100);
    
    return {
      credits,
      amountInCents,
      amountInDollars: amountInCents / 100,
      description: `${credits} 크레딧 구매 (약 ${Math.ceil(credits / 10)}페이지 분석 가능)`,
    };
  }

  // 크레딧 사용량 계산 (페이지 수 기반)
  calculateCreditsForPages(pageCount: number): number {
    // 10페이지 = 100크레딧 = $1
    // 1페이지 = 10크레딧
    return pageCount * 10;
  }

  // 사용자가 특정 작업을 수행할 수 있는지 확인
  async canAffordOperation(userId: number, requiredCredits: number): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    return user ? user.credits >= requiredCredits : false;
  }
} 