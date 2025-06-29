import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CrawlerService } from './crawler.service';
import { PrismaService } from '../prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs';

@Controller('crawler')
@UseGuards(JwtAuthGuard)
export class CrawlerController {
  constructor(
    private crawlerService: CrawlerService,
    private prisma: PrismaService,
  ) {}

  @Post('analyze')
  async startAnalysis(
    @Body() body: { url: string; maxPages?: number },
    @Request() req: any,
  ) {
    const { url, maxPages = 5 } = body;
    const userId = req.user.userId;

    // URL 유효성 검사
    try {
      new URL(url);
    } catch {
      throw new BadRequestException('유효하지 않은 URL입니다.');
    }

    // 사용자 정보 조회
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    // 무료 사용량 확인 (5페이지까지 무료)
    if (maxPages > 5 && user.subscriptionType === 'free') {
      throw new ForbiddenException(
        '무료 사용자는 최대 5페이지까지만 분석할 수 있습니다. 더 많은 페이지를 분석하려면 결제가 필요합니다.',
      );
    }

    // 무료 분석 횟수 확인 (월 5회까지 무료)
    if (user.freeAnalysisCount >= 5 && user.subscriptionType === 'free') {
      throw new ForbiddenException(
        '무료 분석 횟수를 모두 사용했습니다. 추가 분석을 위해서는 결제가 필요합니다.',
      );
    }

    // 크롤링 시작
    const analysisId = await this.crawlerService.startCrawling(
      userId,
      url,
      maxPages,
    );

    // 무료 분석 횟수 증가 (무료 사용자만)
    if (user.subscriptionType === 'free') {
      await this.prisma.user.update({
        where: { id: userId },
        data: { freeAnalysisCount: user.freeAnalysisCount + 1 },
      });
    }

    return {
      analysisId,
      message: '분석이 시작되었습니다. 잠시 후 결과를 확인해주세요.',
      estimatedTime: `약 ${maxPages * 2}초`,
    };
  }

  @Get('analysis/:id')
  async getAnalysis(@Param('id') analysisId: string, @Request() req: any) {
    const userId = req.user.userId;
    const analysis = await this.crawlerService.getAnalysis(analysisId, userId);

    if (!analysis) {
      throw new NotFoundException('분석 결과를 찾을 수 없습니다.');
    }

    return analysis;
  }

  @Get('analysis/:id/visualization')
  async getVisualization(
    @Param('id') analysisId: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;
    const analysis = await this.crawlerService.getAnalysis(analysisId, userId);

    if (!analysis) {
      throw new NotFoundException('분석 결과를 찾을 수 없습니다.');
    }

    if (analysis.status !== 'completed') {
      throw new BadRequestException('분석이 아직 완료되지 않았습니다.');
    }

    const visualizationPath = path.join(
      process.cwd(),
      'uploads',
      analysisId,
      'visualization.html',
    );

    if (!fs.existsSync(visualizationPath)) {
      throw new NotFoundException('시각화 파일을 찾을 수 없습니다.');
    }

    res.sendFile(visualizationPath);
  }

  @Get('analysis/:id/screenshot/:filename')
  async getScreenshot(
    @Param('id') analysisId: string,
    @Param('filename') filename: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;
    const analysis = await this.crawlerService.getAnalysis(analysisId, userId);

    if (!analysis) {
      throw new NotFoundException('분석 결과를 찾을 수 없습니다.');
    }

    const screenshotPath = path.join(
      process.cwd(),
      'uploads',
      analysisId,
      'screenshots',
      filename,
    );

    if (!fs.existsSync(screenshotPath)) {
      throw new NotFoundException('스크린샷을 찾을 수 없습니다.');
    }

    res.sendFile(screenshotPath);
  }

  @Post('analysis/:id/download')
  async downloadFile(
    @Param('id') analysisId: string,
    @Body() body: { fileType: 'png' | 'html' | 'json' },
    @Request() req: any,
  ) {
    const { fileType } = body;
    const userId = req.user.userId;

    const analysis = await this.crawlerService.getAnalysis(analysisId, userId);

    if (!analysis) {
      throw new NotFoundException('분석 결과를 찾을 수 없습니다.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }

    // HTML 다운로드는 프로 구독자만 가능
    if (fileType === 'html' && user.subscriptionType !== 'pro') {
      throw new ForbiddenException(
        'HTML 소스 다운로드는 프로 구독자만 이용할 수 있습니다.',
      );
    }

    let filePath: string;
    let fileName: string;

    switch (fileType) {
      case 'png':
        filePath = path.join(
          process.cwd(),
          'uploads',
          analysisId,
          'visualization.html',
        );
        fileName = `${analysis.title || 'analysis'}-map.png`;
        break;
      case 'html':
        filePath = path.join(
          process.cwd(),
          'uploads',
          analysisId,
          'visualization.html',
        );
        fileName = `${analysis.title || 'analysis'}-visualization.html`;
        break;
      case 'json':
        filePath = path.join(process.cwd(), 'uploads', analysisId, 'data.json');
        fileName = `${analysis.title || 'analysis'}-data.json`;
        
        // JSON 파일이 없으면 생성
        if (!fs.existsSync(filePath)) {
          await fs.promises.writeFile(filePath, analysis.resultData || '{}');
        }
        break;
    }

    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('다운로드할 파일을 찾을 수 없습니다.');
    }

    // 다운로드 기록 저장
    await this.prisma.download.create({
      data: {
        userId,
        analysisId,
        fileType,
        filePath: path.relative(process.cwd(), filePath),
      },
    });

    return {
      downloadUrl: `/crawler/analysis/${analysisId}/file/${fileType}`,
      fileName,
      message: '다운로드 준비가 완료되었습니다.',
    };
  }

  @Get('analysis/:id/file/:fileType')
  async downloadFileStream(
    @Param('id') analysisId: string,
    @Param('fileType') fileType: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const userId = req.user.userId;
    const analysis = await this.crawlerService.getAnalysis(analysisId, userId);

    if (!analysis) {
      throw new NotFoundException('분석 결과를 찾을 수 없습니다.');
    }

    let filePath: string;
    let fileName: string;
    let contentType: string;

    switch (fileType) {
      case 'png':
        // PNG는 실제로는 HTML을 반환 (클라이언트에서 캔버스로 변환)
        filePath = path.join(
          process.cwd(),
          'uploads',
          analysisId,
          'visualization.html',
        );
        fileName = `${analysis.title || 'analysis'}-map.html`;
        contentType = 'text/html';
        break;
      case 'html':
        filePath = path.join(
          process.cwd(),
          'uploads',
          analysisId,
          'visualization.html',
        );
        fileName = `${analysis.title || 'analysis'}-visualization.html`;
        contentType = 'text/html';
        break;
      case 'json':
        filePath = path.join(process.cwd(), 'uploads', analysisId, 'data.json');
        fileName = `${analysis.title || 'analysis'}-data.json`;
        contentType = 'application/json';
        
        // JSON 파일이 없으면 생성
        if (!fs.existsSync(filePath)) {
          await fs.promises.writeFile(filePath, analysis.resultData || '{}');
        }
        break;
      default:
        throw new BadRequestException('지원하지 않는 파일 형식입니다.');
    }

    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('다운로드할 파일을 찾을 수 없습니다.');
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.sendFile(filePath);
  }

  @Get('history')
  async getAnalysisHistory(@Request() req: any) {
    const userId = req.user.userId;
    const analyses = await this.crawlerService.getUserAnalyses(userId);

    return {
      analyses: analyses.map(analysis => ({
        id: analysis.id,
        url: analysis.url,
        title: analysis.title,
        status: analysis.status,
        pageCount: analysis.pageCount,
        createdAt: analysis.createdAt,
        updatedAt: analysis.updatedAt,
      })),
      total: analyses.length,
    };
  }

  @Get('status/:id')
  async getAnalysisStatus(@Param('id') analysisId: string, @Request() req: any) {
    const userId = req.user.userId;
    const analysis = await this.crawlerService.getAnalysis(analysisId, userId);

    if (!analysis) {
      throw new NotFoundException('분석 결과를 찾을 수 없습니다.');
    }

    return {
      id: analysis.id,
      status: analysis.status,
      pageCount: analysis.pageCount,
      progress: analysis.status === 'completed' ? 100 : 
                analysis.status === 'running' ? 50 : 0,
      message: this.getStatusMessage(analysis.status),
    };
  }

  private getStatusMessage(status: string): string {
    switch (status) {
      case 'pending':
        return '분석 대기 중입니다...';
      case 'running':
        return '웹사이트를 분석하고 있습니다...';
      case 'completed':
        return '분석이 완료되었습니다!';
      case 'failed':
        return '분석 중 오류가 발생했습니다.';
      default:
        return '알 수 없는 상태입니다.';
    }
  }
} 