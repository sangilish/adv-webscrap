import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';

export interface CrawlResult {
  id: string;
  url: string;
  title: string;
  pageType: string;
  links: string[];
  images: string[];
  headings: { level: string; text: string }[];
  forms: number;
  buttons: string[];
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

export interface NetworkNode {
  id: string;
  label: string;
  color: string;
  type: string;
  url: string;
  title: string;
  screenshot: string;
}

export interface NetworkEdge {
  from: string;
  to: string;
}

export interface NetworkData {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

export interface AnalysisResult {
  results: CrawlResult[];
  networkData: NetworkData;
  totalPages: number;
  isPreview: boolean;
  previewLimit: number;
  message: string;
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
    this.performOptimizedCrawling(analysis.id, targetUrl, maxPages, user.plan).catch((error) => {
      this.logger.error(`Crawling failed for analysis ${analysis.id}:`, error);
      this.prisma.analysis.update({
        where: { id: analysis.id },
        data: { status: 'failed' },
      });
    });

    return analysis.id;
  }

  private async performOptimizedCrawling(
    analysisId: string,
    startUrl: string,
    maxPages: number,
    userPlan: string,
  ): Promise<void> {
    const startTime = Date.now();
    const results: CrawlResult[] = [];
    const visitedUrls = new Set<string>();
    const baseUrl = new URL(startUrl).origin;
    const sitemap: Record<string, string[]> = {};
    
    // 플랜별 페이지 제한
    const planLimits = {
      FREE: 100,
      PRO: 500,
      ENTERPRISE: 1000
    };
    
    const actualMaxPages = Math.min(maxPages, planLimits[userPlan] || 5);
    
    // 결과 저장 디렉토리 생성
    const outputDir = path.join(process.cwd(), 'uploads', analysisId);
    const screenshotsDir = path.join(outputDir, 'screenshots');
    const htmlDir = path.join(outputDir, 'html');
    
    await fs.promises.mkdir(screenshotsDir, { recursive: true });
    await fs.promises.mkdir(htmlDir, { recursive: true });

    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    try {
      // Phase 1: Fast URL Discovery
      this.logger.log('🚀 Phase 1: Fast URL Discovery');
      const discoveredUrls = await this.fastUrlDiscovery(browser, startUrl, actualMaxPages);
      
      // Phase 2: Parallel Content Extraction
      this.logger.log('🚀 Phase 2: Parallel Content Extraction');
      const crawlResults = await this.parallelCrawl(
        browser, 
        Array.from(discoveredUrls).slice(0, actualMaxPages),
        outputDir,
        analysisId
      );

      // Combine results
      results.push(...crawlResults);

      // Generate network data
      const networkData = this.generateNetworkData(results, sitemap);
      
      // Generate visualization
      const visualizationHtml = this.generateVisualizationHtml(networkData, results);
      const htmlPath = path.join(outputDir, 'visualization.html');
      await fs.promises.writeFile(htmlPath, visualizationHtml);

      // Update analysis
      await this.prisma.analysis.update({
        where: { id: analysisId },
        data: {
          status: 'completed',
          pageCount: results.length,
          progress: 100,
          title: results[0]?.title || 'Website Analysis'
        },
      });

      const duration = (Date.now() - startTime) / 1000;
      this.logger.log(`✅ Crawling completed in ${duration}s. ${results.length} pages crawled.`);

    } catch (error) {
      this.logger.error(`Crawling failed:`, error);
      await this.prisma.analysis.update({
        where: { id: analysisId },
        data: { status: 'failed' },
      });
    } finally {
      await browser.close();
    }
  }

  private async fastUrlDiscovery(
    browser: Browser,
    startUrl: string,
    maxUrls: number
  ): Promise<Set<string>> {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; WebCrawler/1.0)',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();
    const discoveredUrls = new Set<string>([startUrl]);
    const baseUrl = new URL(startUrl).origin;
    const urlQueue = [startUrl];
    const processed = new Set<string>();

    try {
      while (urlQueue.length > 0 && discoveredUrls.size < maxUrls) {
        const currentUrl = urlQueue.shift()!;
        if (processed.has(currentUrl)) continue;
        processed.add(currentUrl);

        try {
          await page.goto(currentUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 10000 
          });

          // Quick wait for dynamic content
          await page.waitForTimeout(500);

          // Extract all links at once
          const links = await page.evaluate((baseUrl) => {
            const urls = new Set<string>();
            
            // All anchor tags
            document.querySelectorAll('a[href]').forEach(a => {
              try {
                const href = (a as HTMLAnchorElement).href;
                const url = new URL(href);
                if (url.origin === baseUrl && !href.includes('#')) {
                  urls.add(href);
                }
              } catch {}
            });

            // Look for common navigation patterns
            document.querySelectorAll('[data-href], [data-url], [data-link]').forEach(el => {
              const url = el.getAttribute('data-href') || 
                         el.getAttribute('data-url') || 
                         el.getAttribute('data-link');
              if (url) {
                try {
                  const fullUrl = new URL(url, baseUrl);
                  if (fullUrl.origin === baseUrl) {
                    urls.add(fullUrl.href);
                  }
                } catch {}
              }
            });

            return Array.from(urls);
          }, baseUrl);

          // Add discovered links
          for (const link of links) {
            if (!discoveredUrls.has(link) && discoveredUrls.size < maxUrls) {
              discoveredUrls.add(link);
              urlQueue.push(link);
            }
          }

        } catch (error) {
          this.logger.warn(`Failed to discover URLs from ${currentUrl}`);
        }
      }
    } finally {
      await context.close();
    }

    this.logger.log(`📊 Discovered ${discoveredUrls.size} URLs`);
    return discoveredUrls;
  }

  private async parallelCrawl(
    browser: Browser,
    urls: string[],
    outputDir: string,
    analysisId: string
  ): Promise<CrawlResult[]> {
    const results: CrawlResult[] = [];
    const limit = pLimit(5); // 5 concurrent pages
    
    // Create contexts for parallel crawling
    const contexts = await Promise.all(
      Array(Math.min(5, urls.length)).fill(0).map(() => 
        browser.newContext({
          userAgent: 'Mozilla/5.0 (compatible; WebCrawler/1.0)',
          viewport: { width: 1280, height: 800 }
        })
      )
    );

    let contextIndex = 0;

    const crawlTasks = urls.map((url, index) => 
      limit(async () => {
        const context = contexts[contextIndex % contexts.length];
        contextIndex++;
        
        const page = await context.newPage();
        
        try {
          const result = await this.fastCrawlPage(page, url, outputDir, index, urls.length, analysisId);
          results.push(result);
          return result;
        } catch (error) {
          this.logger.error(`Failed to crawl ${url}:`, error);
          return null;
        } finally {
          await page.close();
        }
      })
    );

    await Promise.all(crawlTasks);

    // Cleanup contexts
    await Promise.all(contexts.map(ctx => ctx.close()));

    return results.filter(r => r !== null) as CrawlResult[];
  }

  private async fastCrawlPage(
    page: Page, 
    url: string, 
    outputDir: string,
    index: number,
    total: number,
    analysisId: string
  ): Promise<CrawlResult> {
    const timestamp = new Date().toISOString();
    const pageId = `page_${Date.now()}_${index}`;

    this.logger.log(`🔍 Crawling (${index + 1}/${total}): ${url}`);

    // Navigate with minimal wait
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 15000 
    });

    // Quick wait for initial render
    await page.waitForTimeout(1000);

    // Remove cookie popups in parallel with content extraction
    const cookiePromise = this.quickRemoveCookies(page);
    
    // Extract data
    const [pageData, _] = await Promise.all([
      page.evaluate(() => {
        const currentOrigin = location.origin;

        // Extract links
        const links = Array.from(new Set(
          Array.from(document.querySelectorAll('a[href]'))
            .map(a => (a as HTMLAnchorElement).href)
            .filter(href => {
              try {
                const url = new URL(href);
                return url.origin === currentOrigin && !href.includes('#');
              } catch {
                return false;
              }
            })
        ));

        // Extract other data
        const images = Array.from(document.querySelectorAll('img[src]'))
          .map(img => (img as HTMLImageElement).src)
          .filter(src => src && !src.startsWith('data:'))
          .slice(0, 10); // Limit images

        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
          .slice(0, 20) // Limit headings
          .map(h => ({ 
            level: h.tagName.toLowerCase(), 
            text: h.textContent?.trim() || '' 
          }));

        const forms = document.querySelectorAll('form').length;
        const buttons = Array.from(document.querySelectorAll('button'))
          .slice(0, 10)
          .map(btn => btn.textContent?.trim() || '')
          .filter(t => t);

        // Get text content (limited)
        const textContent = document.body?.innerText?.slice(0, 5000) || '';

        return {
          title: document.title || '',
          links,
          images,
          headings,
          forms,
          buttons,
          textContent,
          wordCount: textContent.split(/\s+/).length
        };
      }),
      cookiePromise
    ]);

    // Take screenshot
    const screenshotFilename = `${pageId}.png`;
    const screenshotPath = path.join(outputDir, 'screenshots', screenshotFilename);
    
    await page.screenshot({
      path: screenshotPath,
      fullPage: false, // Faster with viewport only
      type: 'png'
    });

    // Save HTML (optional - can skip for speed)
    const htmlFilename = `${pageId}.html`;
    const htmlPath = path.join(outputDir, 'html', htmlFilename);
    const htmlContent = await page.content();
    await fs.promises.writeFile(htmlPath, htmlContent);

    // Determine page type
    let pageType = '일반페이지';
    const pathname = new URL(url).pathname.toLowerCase();
    const titleLower = pageData.title.toLowerCase();
    
    if (pathname === '/' || pathname === '/home' || titleLower.includes('home')) {
      pageType = '홈페이지';
    } else if (pathname.includes('about') || titleLower.includes('about')) {
      pageType = '소개페이지';
    } else if (pathname.includes('contact') || titleLower.includes('contact')) {
      pageType = '연락처';
    } else if (pathname.includes('product') || titleLower.includes('product')) {
      pageType = '제품페이지';
    } else if (pathname.includes('service') || titleLower.includes('service')) {
      pageType = '서비스페이지';
    }

    // Update progress
    await this.prisma.analysis.update({
      where: { id: analysisId },
      data: { 
        progress: Math.round(((index + 1) / total) * 100)
      },
    }).catch(() => {}); // Ignore errors

    return {
      id: pageId,
      url,
      title: pageData.title,
      pageType,
      links: pageData.links,
      images: pageData.images,
      headings: pageData.headings,
      forms: pageData.forms,
      buttons: pageData.buttons,
      textContent: pageData.textContent,
      screenshotPath: `/uploads/${path.basename(outputDir)}/screenshots/${screenshotFilename}`,
      htmlPath: `/uploads/${path.basename(outputDir)}/html/${htmlFilename}`,
      timestamp,
      metadata: {
        wordCount: pageData.wordCount,
        imageCount: pageData.images.length,
        linkCount: pageData.links.length
      }
    };
  }

  private async quickRemoveCookies(page: Page): Promise<void> {
    try {
      // Inject CSS to hide common cookie elements
      await page.addStyleTag({
        content: `
          [class*="cookie"], [id*="cookie"], [class*="consent"], 
          [id*="consent"], [class*="gdpr"], [id*="gdpr"],
          [class*="banner"], [id*="banner"], .modal, .popup {
            display: none !important;
            visibility: hidden !important;
          }
        `
      });

      // Try to click accept buttons
      const acceptSelectors = [
        'button:has-text("Accept")',
        'button:has-text("OK")',
        'button:has-text("Agree")',
        '[id*="accept"]',
        '[class*="accept"]'
      ];

      for (const selector of acceptSelectors) {
        await page.click(selector, { timeout: 1000 }).catch(() => {});
      }
    } catch {
      // Ignore errors
    }
  }

  // 무료 미리보기 - 더 빠르게!
  async getPreviewAnalysis(url: string): Promise<AnalysisResult> {
    this.logger.log(`Starting fast preview for: ${url}`);
    
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    try {
      new URL(url);
      
      const outputDir = path.join(process.cwd(), 'temp', `preview_${Date.now()}`);
      await fs.promises.mkdir(outputDir, { recursive: true });
      
      // Fast discovery
      const urls = await this.fastUrlDiscovery(browser, url, 30);
      
      // Parallel crawl
      const results = await this.parallelCrawl(
        browser,
        Array.from(urls).slice(0, 30),
        outputDir,
        'preview'
      );
      
      // Generate network data
      const sitemap: Record<string, string[]> = {};
      results.forEach(result => {
        sitemap[result.url] = result.links.filter(link => 
          urls.has(link) && link !== result.url
        );
      });
      
      const networkData = this.generateNetworkData(results, sitemap);
      
      return {
        results,
        networkData,
        totalPages: results.length,
        isPreview: true,
        previewLimit: 30,
        message: `미리보기로 ${results.length}개 페이지를 분석했습니다. 전체 분석을 원하시면 로그인해주세요.`
      };
      
    } catch (error) {
      this.logger.error(`Preview failed:`, error);
      throw error;
    } finally {
      await browser.close();
    }
  }

  // 기존 헬퍼 메서드들은 그대로 유지
  private generateNetworkData(results: CrawlResult[], sitemap: Record<string, string[]>): NetworkData {
    const nodes: NetworkNode[] = [];
    const edges: NetworkEdge[] = [];
    const processedUrls = new Set<string>();
    
    results.forEach((result) => {
      if (!processedUrls.has(result.url)) {
        processedUrls.add(result.url);
        
        let color = '#6366f1';
        switch (result.pageType) {
          case '홈페이지': color = '#ef4444'; break;
          case '소개페이지': color = '#10b981'; break;
          case '연락처': color = '#f59e0b'; break;
          case '제품페이지': color = '#8b5cf6'; break;
          case '서비스페이지': color = '#06b6d4'; break;
        }
        
        nodes.push({
          id: result.id,
          label: result.title.substring(0, 30) + (result.title.length > 30 ? '...' : ''),
          color,
          type: result.pageType,
          url: result.url,
          title: result.title,
          screenshot: result.screenshotPath
        });
      }
    });
    
    // Create edges based on links
    results.forEach(result => {
      result.links.forEach(link => {
        const targetResult = results.find(r => r.url === link);
        if (targetResult) {
          edges.push({
            from: result.id,
            to: targetResult.id
          });
        }
      });
    });
    
    return { nodes, edges };
  }

  private generateVisualizationHtml(networkData: NetworkData, results: CrawlResult[]): string {
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

  // 나머지 메서드들 (getUserAnalyses, getAnalysis, downloadFile 등)은 그대로 유지...
  
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
} 