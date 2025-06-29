import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
  Query,
  Res,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CrawlerService } from './crawler.service';
import { PrismaService } from '../prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs';

@Controller('crawler')
export class CrawlerController {
  constructor(
    private crawlerService: CrawlerService,
    private prisma: PrismaService,
  ) {}

  // 무료 미리보기 (로그인 불필요)
  @Post('preview')
  async getPreview(@Body('url') url: string, @Res({ passthrough: true }) response: Response) {
    console.log('Preview endpoint called with URL:', url);
    
    // CORS 헤더 직접 설정
    response.header('Access-Control-Allow-Origin', 'http://localhost:3000');
    response.header('Access-Control-Allow-Credentials', 'true');
    response.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    response.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
    
    if (!url) {
      throw new BadRequestException('URL is required');
    }

    try {
      new URL(url); // URL 유효성 검사
    } catch (error) {
      throw new BadRequestException('Invalid URL format');
    }

    console.log('Calling crawlerService.getPreviewAnalysis...');
    const result = await this.crawlerService.getPreviewAnalysis(url);
    console.log('Service returned:', result);
    return result;
  }

  // 실제 크롤링 시작 (로그인 필요)
  @UseGuards(JwtAuthGuard)
  @Post('start')
  async startCrawling(
    @Request() req,
    @Body() body: { url: string; maxPages?: number }
  ) {
    const { url, maxPages = 5 } = body;
    
    if (!url) {
      throw new BadRequestException('URL is required');
    }

    try {
      new URL(url);
    } catch (error) {
      throw new BadRequestException('Invalid URL format');
    }

    const analysisId = await this.crawlerService.startCrawling(
      req.user.userId,
      url,
      maxPages
    );

    return {
      analysisId,
      message: 'Crawling started successfully',
      status: 'running'
    };
  }

  // 분석 진행률 확인
  @UseGuards(JwtAuthGuard)
  @Get('analysis/:id/status')
  async getAnalysisStatus(@Request() req, @Param('id') analysisId: string) {
    const analysis = await this.crawlerService.getAnalysis(analysisId, req.user.userId);
    
    return {
      id: analysis.id,
      status: analysis.status,
      progress: analysis.progress || 0,
      pageCount: analysis.pageCount || 0,
      url: analysis.url,
      title: analysis.title
    };
  }

  // 분석 결과 조회
  @UseGuards(JwtAuthGuard)
  @Get('analysis/:id')
  async getAnalysis(@Request() req, @Param('id') analysisId: string) {
    return this.crawlerService.getAnalysis(analysisId, req.user.userId);
  }

  // 사용자 분석 목록 조회
  @UseGuards(JwtAuthGuard)
  @Get('analyses')
  async getUserAnalyses(@Request() req, @Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit) : undefined;
    return this.crawlerService.getUserAnalyses(req.user.userId, limitNum);
  }

  // 파일 다운로드 (PNG/HTML)
  @UseGuards(JwtAuthGuard)
  @Get('download/:analysisId/:pageId/:fileType')
  async downloadFile(
    @Request() req,
    @Param('analysisId') analysisId: string,
    @Param('pageId') pageId: string,
    @Param('fileType') fileType: 'png' | 'html',
    @Res() res: Response
  ) {
    if (!['png', 'html'].includes(fileType)) {
      throw new BadRequestException('Invalid file type. Must be png or html');
    }

    const fileInfo = await this.crawlerService.downloadFile(
      analysisId,
      req.user.userId,
      fileType,
      pageId
    );

    const fileStream = fs.createReadStream(fileInfo.filePath);
    
    res.setHeader('Content-Type', fileInfo.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.filename}"`);
    
    fileStream.pipe(res);
  }

  // 스크린샷 이미지 조회 (미리보기용)
  @Get('screenshot/:analysisId/:filename')
  async getScreenshot(
    @Param('analysisId') analysisId: string,
    @Param('filename') filename: string,
    @Res() res: Response
  ) {
    const imagePath = `uploads/${analysisId}/screenshots/${filename}`;
    const fullPath = require('path').join(process.cwd(), imagePath);

    if (!fs.existsSync(fullPath)) {
      throw new BadRequestException('Screenshot not found');
    }

    res.sendFile(fullPath);
  }

  // 임시 미리보기 스크린샷 조회
  @Get('temp-screenshot/:tempId/:filename')
  async getTempScreenshot(
    @Param('tempId') tempId: string,
    @Param('filename') filename: string,
    @Res() res: Response
  ) {
    const imagePath = `temp/${tempId}/screenshots/${filename}`;
    const fullPath = require('path').join(process.cwd(), imagePath);

    if (!fs.existsSync(fullPath)) {
      throw new BadRequestException('Screenshot not found');
    }

    res.sendFile(fullPath);
  }
} 