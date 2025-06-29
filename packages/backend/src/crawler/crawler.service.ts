import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface CrawlResult {
  id: string;
  url: string;
  title: string;
  pageType: string;
  links: string[];
  images: string[];
  headings: { level: string; text: string }[];
  forms: number;
  textContent: string;
  screenshotPath: string;
  htmlPath: string;
  timestamp: string;
  metadata: {
    wordCount: number;
    imageCount: number;
    linkCount: number;
  };
}

export interface NetworkData {
  nodes: Array<{
    id: string;
    label: string;
    color: string;
    type: string;
    url: string;
    title: string;
    screenshot: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
  }>;
}

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);

  constructor(private prisma: PrismaService) {}

  async startCrawling(
    userId: number,
    targetUrl: string,
    maxPages: number = 5,
  ): Promise<string> {
    // 사용자 플랜 확인
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { analyses: true }
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Free 플랜 제한 확인 (월 10개)
    const currentMonth = new Date();
    currentMonth.setDate(1);
    currentMonth.setHours(0, 0, 0, 0);
    
    const monthlyAnalyses = user.analyses.filter(
      analysis => new Date(analysis.createdAt) >= currentMonth
    );

    if (user.plan === 'FREE' && monthlyAnalyses.length >= 10) {
      throw new BadRequestException('Monthly crawling limit reached. Please upgrade to Pro.');
    }

    // 분석 레코드 생성
    const analysis = await this.prisma.analysis.create({
      data: {
        userId,
        url: targetUrl,
        status: 'running',
      },
    });

    // 백그라운드에서 크롤링 실행
    this.performCrawling(analysis.id, targetUrl, maxPages, user.plan).catch((error) => {
      this.logger.error(`Crawling failed for analysis ${analysis.id}:`, error);
      this.prisma.analysis.update({
        where: { id: analysis.id },
        data: { status: 'failed' },
      });
    });

    return analysis.id;
  }

  private async performCrawling(
    analysisId: string,
    startUrl: string,
    maxPages: number,
    userPlan: string,
  ): Promise<void> {
    const results: CrawlResult[] = [];
    const visitedUrls = new Set<string>();
    const baseUrl = new URL(startUrl).origin;
    
    // 플랜별 페이지 제한
    const planLimits = {
      FREE: 5,
      PRO: 100,
      ENTERPRISE: 1000
    };
    
    const actualMaxPages = Math.min(maxPages, planLimits[userPlan] || 5);
    
    // 결과 저장 디렉토리 생성
    const outputDir = path.join(process.cwd(), 'uploads', analysisId);
    const screenshotsDir = path.join(outputDir, 'screenshots');
    const htmlDir = path.join(outputDir, 'html');
    
    await fs.promises.mkdir(screenshotsDir, { recursive: true });
    await fs.promises.mkdir(htmlDir, { recursive: true });

    // Playwright 브라우저 실행
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });

    try {
      const urlsToVisit = [startUrl];
      
      while (urlsToVisit.length > 0 && results.length < actualMaxPages) {
        const currentUrl = urlsToVisit.shift();
        
        if (!currentUrl || visitedUrls.has(currentUrl)) {
          continue;
        }
        
        visitedUrls.add(currentUrl);
        this.logger.log(`Crawling: ${currentUrl} (${results.length + 1}/${actualMaxPages})`);

        const page = await context.newPage();
        
        try {
          await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 15000 });
          
          // 쿠키 팝업 제거
          await this.removeCookiePopups(page);
          
          // 데이터 추출
          const result = await this.extractPageData(page, currentUrl, analysisId, screenshotsDir, htmlDir);
          results.push(result);

          // 진행률 업데이트
          await this.prisma.analysis.update({
            where: { id: analysisId },
            data: { 
              pageCount: results.length,
              progress: Math.round((results.length / actualMaxPages) * 100)
            },
          });

          // 같은 도메인의 새로운 링크 찾기
          if (results.length < actualMaxPages) {
            const links = await page.$$eval('a[href]', (anchors) => 
              anchors.map(a => a.href).filter(href => href && href.startsWith('http'))
            );
            
            for (const link of links) {
              try {
                const linkUrl = new URL(link);
                if (linkUrl.origin === baseUrl && !visitedUrls.has(link) && !urlsToVisit.includes(link)) {
                  urlsToVisit.push(link);
                }
              } catch (e) {
                // 잘못된 URL 무시
              }
            }
          }
        } catch (error) {
          this.logger.error(`Error crawling ${currentUrl}:`, error);
        } finally {
          await page.close();
        }
      }
      
      // 네트워크 데이터 생성
      const networkData = this.generateNetworkData(results);
      
      // 시각화 HTML 생성
      const visualizationHtml = this.generateVisualizationHtml(networkData, results);
      const htmlPath = path.join(outputDir, 'visualization.html');
      await fs.promises.writeFile(htmlPath, visualizationHtml);

      // 분석 완료 업데이트
      await this.prisma.analysis.update({
        where: { id: analysisId },
        data: {
          status: 'completed',
          pageCount: results.length,
          progress: 100,
          completedAt: new Date(),
        },
      });

      this.logger.log(`Crawling completed for analysis ${analysisId}. ${results.length} pages crawled.`);
    } catch (error) {
      this.logger.error(`Crawling failed for analysis ${analysisId}:`, error);
      await this.prisma.analysis.update({
        where: { id: analysisId },
        data: { status: 'failed' },
      });
    } finally {
      await browser.close();
    }
  }

  private async removeCookiePopups(page: any): Promise<void> {
    const cookieSelectors = [
      '[class*="cookie"]',
      '[id*="cookie"]',
      '[class*="consent"]',
      '[id*="consent"]',
      '[class*="gdpr"]',
      '[id*="gdpr"]',
      '[class*="banner"]',
      '[class*="popup"]',
      '[class*="modal"]'
    ];

    for (const selector of cookieSelectors) {
      try {
        const elements = await page.$$(selector);
        for (const element of elements) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            await element.evaluate((el) => el.remove());
          }
        }
      } catch (error) {
        // 무시
      }
    }

    // Accept 버튼 클릭 시도
    const acceptSelectors = [
      'button:has-text("Accept")',
      'button:has-text("Accept All")',
      'button:has-text("OK")',
      'button:has-text("Got it")',
      '[class*="accept"]',
      '[id*="accept"]'
    ];

    for (const selector of acceptSelectors) {
      try {
        const button = await page.$(selector);
        if (button && await button.isVisible()) {
          await button.click();
          await page.waitForTimeout(1000);
          break;
        }
      } catch (error) {
        // 무시
      }
    }
  }

  private async extractPageData(
    page: any,
    url: string,
    analysisId: string,
    screenshotsDir: string,
    htmlDir: string,
  ): Promise<CrawlResult> {
    const timestamp = new Date().toISOString();
    const urlHash = Buffer.from(url).toString('base64').replace(/[/+=]/g, '-');
    const pageId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // 스크린샷 캡처 (전체 페이지)
    const screenshotFilename = `${pageId}.png`;
    const screenshotPath = path.join(screenshotsDir, screenshotFilename);
    
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      type: 'png'
    });

    // HTML 저장
    const htmlContent = await page.content();
    const htmlFilename = `${pageId}.html`;
    const htmlPath = path.join(htmlDir, htmlFilename);
    await fs.promises.writeFile(htmlPath, htmlContent);

    // 페이지 데이터 추출
    const pageData = await page.evaluate(() => {
      const title = document.title || '';
      
      // 링크 추출
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => (a as HTMLAnchorElement).href)
        .filter(href => href && !href.startsWith('javascript:') && !href.startsWith('mailto:'));

      // 이미지 추출
      const images = Array.from(document.querySelectorAll('img[src]'))
        .map(img => (img as HTMLImageElement).src)
        .filter(src => src);

      // 헤딩 추출
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .map(h => ({
          level: h.tagName.toLowerCase(),
          text: h.textContent?.trim() || ''
        }))
        .filter(h => h.text);

      // 폼 개수
      const forms = document.querySelectorAll('form').length;

      // 텍스트 내용
      const textContent = document.body?.textContent?.trim() || '';
      
      return {
        title,
        links,
        images,
        headings,
        forms,
        textContent
      };
    });

    // 페이지 타입 분류
    const pageType = this.classifyPageType(url, pageData.title, pageData.headings);

    // 미리보기인지 확인 (analysisId가 preview_로 시작하는 경우)
    const isPreview = analysisId.startsWith('preview_');
    const screenshotUrl = isPreview 
      ? `/temp/${analysisId}/screenshots/${screenshotFilename}`
      : `/uploads/${analysisId}/screenshots/${screenshotFilename}`;
    const htmlUrl = isPreview
      ? `/temp/${analysisId}/html/${htmlFilename}`
      : `/uploads/${analysisId}/html/${htmlFilename}`;

    const result: CrawlResult = {
      id: pageId,
      url,
      title: pageData.title,
      pageType,
      links: pageData.links,
      images: pageData.images,
      headings: pageData.headings,
      forms: pageData.forms,
      textContent: pageData.textContent,
      screenshotPath: screenshotUrl,
      htmlPath: htmlUrl,
      timestamp,
      metadata: {
        wordCount: pageData.textContent.split(/\s+/).length,
        imageCount: pageData.images.length,
        linkCount: pageData.links.length
      }
    };

    return result;
  }

  private classifyPageType(url: string, title: string, headings: any[]): string {
    const urlLower = url.toLowerCase();
    const titleLower = title.toLowerCase();
    
    if (urlLower.includes('/blog') || urlLower.includes('/news') || titleLower.includes('blog')) {
      return 'blog';
    } else if (urlLower.includes('/product') || urlLower.includes('/shop') || titleLower.includes('product')) {
      return 'product';
    } else if (urlLower.includes('/about') || titleLower.includes('about')) {
      return 'about';
    } else if (urlLower.includes('/contact') || titleLower.includes('contact')) {
      return 'contact';
    } else if (url === new URL(url).origin || urlLower.endsWith('/') && urlLower.split('/').length <= 4) {
      return 'homepage';
    }
    return 'page';
  }

  private generateNetworkData(results: CrawlResult[]): NetworkData {
    const nodes = results.map(result => ({
      id: result.id,
      label: result.title || 'Untitled',
      color: this.getColorByPageType(result.pageType),
      type: result.pageType,
      url: result.url,
      title: result.title,
      screenshot: result.screenshotPath
    }));

    const edges: Array<{ from: string; to: string }> = [];
    
    // 링크 관계 생성
    results.forEach(fromResult => {
      fromResult.links.forEach(link => {
        const toResult = results.find(r => r.url === link);
        if (toResult && fromResult.id !== toResult.id) {
          edges.push({
            from: fromResult.id,
            to: toResult.id
          });
        }
      });
    });

    return { nodes, edges };
  }

  private getColorByPageType(pageType: string): string {
    const colors = {
      homepage: '#FF6B6B',
      about: '#4ECDC4', 
      contact: '#45B7D1',
      product: '#96CEB4',
      blog: '#FFEAA7',
      page: '#DDA0DD'
    };
    return colors[pageType] || colors.page;
  }

  // 사용자별 분석 조회 (Free 유저는 5개만)
  async getUserAnalyses(userId: number, limit?: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }
    });

    const actualLimit = user?.plan === 'FREE' ? 5 : (limit || 50);

    return this.prisma.analysis.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: actualLimit,
      select: {
        id: true,
        url: true,
        title: true,
        status: true,
        pageCount: true,
        progress: true,
        createdAt: true,
        updatedAt: true
      }
    });
  }

  // 분석 상세 조회
  async getAnalysis(analysisId: string, userId: number) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { 
        id: analysisId, 
        userId 
      }
    });

    if (!analysis) {
      throw new BadRequestException('Analysis not found');
    }

    return {
      ...analysis,
      resultData: analysis.resultData ? JSON.parse(analysis.resultData) : null
    };
  }

  // 무료 미리보기 (로그인 없이 5개 페이지만)
  async getPreviewAnalysis(url: string): Promise<any> {
    this.logger.log(`Starting preview analysis for: ${url}`);
    
    const tempId = `preview_${Date.now()}`;
    const results: CrawlResult[] = [];
    const visitedUrls = new Set<string>();
    
    // 임시 디렉토리 생성
    const tempDir = path.join(process.cwd(), 'temp', tempId);
    const screenshotsDir = path.join(tempDir, 'screenshots');
    const htmlDir = path.join(tempDir, 'html');
    
    await fs.promises.mkdir(screenshotsDir, { recursive: true });
    await fs.promises.mkdir(htmlDir, { recursive: true });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    });

    try {
      const baseUrl = new URL(url).origin;
      const urlsToVisit = [url];
      const maxPages = 5; // 미리보기는 5페이지 제한
      
      while (urlsToVisit.length > 0 && results.length < maxPages) {
        const currentUrl = urlsToVisit.shift();
        
        if (!currentUrl || visitedUrls.has(currentUrl)) {
          continue;
        }
        
        visitedUrls.add(currentUrl);
        this.logger.log(`Preview crawling: ${currentUrl} (${results.length + 1}/${maxPages})`);
        
        const page = await context.newPage();
        
        try {
          await page.goto(currentUrl, { waitUntil: 'networkidle', timeout: 15000 });
          
          // 쿠키 팝업 제거
          await this.removeCookiePopups(page);
          
          // 데이터 추출
          const result = await this.extractPageData(page, currentUrl, tempId, screenshotsDir, htmlDir);
          results.push(result);
          
          // 같은 도메인의 새로운 링크 찾기
          if (results.length < maxPages) {
            const links = await page.$$eval('a[href]', (anchors) => 
              anchors.map(a => a.href).filter(href => href && href.startsWith('http'))
            );
            
            for (const link of links.slice(0, 10)) { // 최대 10개 링크만 확인
              try {
                const linkUrl = new URL(link);
                if (linkUrl.origin === baseUrl && !visitedUrls.has(link) && !urlsToVisit.includes(link)) {
                  urlsToVisit.push(link);
                }
              } catch (e) {
                // 잘못된 URL 무시
              }
            }
          }
        } catch (error) {
          this.logger.error(`Error crawling ${currentUrl}:`, error);
        } finally {
          await page.close();
        }
      }
      
      const networkData = this.generateNetworkData(results);
      
      this.logger.log(`Preview analysis completed for: ${url}, results: ${results.length}`);

      return {
        results,
        networkData,
        totalPages: results.length,
        isPreview: true,
        previewLimit: 5
      };
    } catch (error) {
      this.logger.error(`Preview analysis failed for ${url}:`, error);
      
      // 오류 발생 시 기본 목업 데이터 반환
      const mockResults: CrawlResult[] = [
        {
          id: `page_${Date.now()}_mock`,
          url,
          title: 'Sample Page Title',
          pageType: 'homepage',
          links: [],
          images: [],
          headings: [{ level: 'h1', text: 'Main Heading' }],
          forms: 0,
          textContent: 'Sample content from the crawled page.',
          screenshotPath: `/temp/${tempId}/screenshots/mock.png`,
          htmlPath: `/temp/${tempId}/html/mock.html`,
          timestamp: new Date().toISOString(),
          metadata: {
            wordCount: 8,
            imageCount: 0,
            linkCount: 0
          }
        }
      ];

      const networkData = this.generateNetworkData(mockResults);
      
      return {
        results: mockResults,
        networkData,
        totalPages: mockResults.length,
        isPreview: true,
        previewLimit: 5,
        error: 'Crawling failed, showing sample data'
      };
    } finally {
      await browser.close();
    }
  }

  private async crawlSinglePage(
    page: any,
    url: string,
    tempId: string,
    screenshotsDir: string,
    htmlDir: string,
    results: CrawlResult[],
    visitedUrls: Set<string>
  ): Promise<void> {
    if (visitedUrls.has(url)) return;
    
    visitedUrls.add(url);
    this.logger.log(`Crawling: ${url} (${visitedUrls.size})`);

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      
      // 쿠키 팝업 제거
      await this.removeCookiePopups(page);
      
      // 데이터 추출
      const result = await this.extractPageData(page, url, tempId, screenshotsDir, htmlDir);
      results.push(result);
    } catch (error) {
      this.logger.error(`Error crawling ${url}:`, error);
    }
  }

  // 파일 다운로드 (로그인 필요)
  async downloadFile(analysisId: string, userId: number, fileType: 'png' | 'html', pageId: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { 
        id: analysisId, 
        userId,
        status: 'completed'
      }
    });

    if (!analysis) {
      throw new BadRequestException('Analysis not found or not completed');
    }

    const resultData = analysis.resultData ? JSON.parse(analysis.resultData) : null;
    if (!resultData?.results) {
      throw new BadRequestException('No results found');
    }

    const page = resultData.results.find(r => r.id === pageId);
    if (!page) {
      throw new BadRequestException('Page not found');
    }

    const filePath = fileType === 'png' ? page.screenshotPath : page.htmlPath;
    const fullPath = path.join(process.cwd(), filePath.replace('/uploads/', 'uploads/'));

    if (!fs.existsSync(fullPath)) {
      throw new BadRequestException('File not found');
    }

    return {
      filePath: fullPath,
      filename: path.basename(fullPath),
      contentType: fileType === 'png' ? 'image/png' : 'text/html'
    };
  }

  private generateVisualizationHtml(networkData: NetworkData, results: CrawlResult[]): string {
    // 기존 시각화 HTML 생성 코드 유지
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Website Structure Visualization</title>
    <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        #network { height: 600px; border: 1px solid #ccc; }
        .info-panel { margin-top: 20px; padding: 15px; background: #f5f5f5; border-radius: 8px; }
        .page-info { margin: 10px 0; padding: 10px; background: white; border-radius: 4px; }
    </style>
</head>
<body>
    <h1>Website Structure Analysis</h1>
    <div id="network"></div>
    <div class="info-panel">
        <h3>Analysis Summary</h3>
        <p><strong>Total Pages:</strong> ${results.length}</p>
        <p><strong>Total Links:</strong> ${results.reduce((sum, r) => sum + r.links.length, 0)}</p>
        <p><strong>Total Images:</strong> ${results.reduce((sum, r) => sum + r.images.length, 0)}</p>
    </div>
    
    <script>
        const nodes = new vis.DataSet(${JSON.stringify(networkData.nodes)});
        const edges = new vis.DataSet(${JSON.stringify(networkData.edges)});
        const container = document.getElementById('network');
        const data = { nodes: nodes, edges: edges };
        const options = {
            nodes: {
                shape: 'dot',
                size: 20,
                font: { size: 12 }
            },
            edges: {
                arrows: 'to'
            },
            physics: {
                enabled: true,
                stabilization: { iterations: 100 }
            }
        };
        const network = new vis.Network(container, data, options);
    </script>
</body>
</html>`;
  }
} 