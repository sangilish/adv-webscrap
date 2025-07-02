import { IsString, IsInt, IsOptional, Min } from 'class-validator';

export class CreateCreditTransactionDto {
  @IsString()
  type: string; // "purchase", "usage", "refund", "bonus"

  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  paymentId?: string;

  @IsOptional()
  @IsString()
  analysisId?: string;
}

export class CreditBalanceDto {
  credits: number;
  totalCreditsEarned: number;
  totalCreditsUsed: number;
  recentTransactions: CreditTransactionResponseDto[];
}

export class CreditTransactionResponseDto {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  createdAt: Date;
}

export class PurchaseCreditsDto {
  @IsInt()
  @Min(1)
  credits: number; // 구매할 크레딧 수 (100 크레딧 = $1)
} 