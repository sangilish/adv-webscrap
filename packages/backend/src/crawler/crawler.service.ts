import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface CrawlResult {
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
    // 분석 레코드 생성
    const analysis = await this.prisma.analysis.create({
      data: {
        userId,
        url: targetUrl,
        status: 'running',
      },
    });

    // 백그라운드에서 크롤링 실행
    this.performCrawling(analysis.id, targetUrl, maxPages).catch((error) => {
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
  ): Promise<void> {
    const results: CrawlResult[] = [];
    const visitedUrls = new Set<string>();
    const baseUrl = new URL(startUrl).origin;
    
    // 결과 저장 디렉토리 생성
    const outputDir = path.join(process.cwd(), 'uploads', analysisId);
    const screenshotsDir = path.join(outputDir, 'screenshots');
    const htmlDir = path.join(outputDir, 'html');
    
    await fs.promises.mkdir(screenshotsDir, { recursive: true });
    await fs.promises.mkdir(htmlDir, { recursive: true });

    const crawler = new PlaywrightCrawler({
      maxRequestsPerCrawl: maxPages,
      requestHandler: async ({ page, request, enqueueLinks }) => {
        const url = request.loadedUrl || request.url;
        
        if (visitedUrls.has(url) || visitedUrls.size >= maxPages) {
          return;
        }
        
        visitedUrls.add(url);
        this.logger.log(`Crawling: ${url}`);

        try {
          // 페이지 대기
          await page.waitForLoadState('networkidle', { timeout: 10000 });
          
          // 쿠키 팝업 제거
          await this.removeCookiePopups(page);
          
          // 데이터 추출
          const result = await this.extractPageData(page, url, analysisId, screenshotsDir, htmlDir);
          results.push(result);

          // 같은 도메인의 링크만 큐에 추가
          if (visitedUrls.size < maxPages) {
            await enqueueLinks({
              selector: 'a[href]',
              baseUrl: url,
              transformRequestFunction: (req) => {
                const reqUrl = new URL(req.url);
                if (reqUrl.origin === baseUrl && !visitedUrls.has(req.url)) {
                  return req;
                }
                return false;
              },
            });
          }
        } catch (error) {
          this.logger.error(`Error crawling ${url}:`, error);
        }
      },
      failedRequestHandler: async ({ request }) => {
        this.logger.error(`Failed to crawl: ${request.url}`);
      },
    });

    try {
      await crawler.run([startUrl]);
      
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
          resultData: JSON.stringify({
            results,
            networkData,
          }),
          title: results[0]?.title || 'Unknown',
        },
      });

      this.logger.log(`Crawling completed for analysis ${analysisId}`);
    } catch (error) {
      this.logger.error(`Crawling failed:`, error);
      await this.prisma.analysis.update({
        where: { id: analysisId },
        data: { status: 'failed' },
      });
    }
  }

  private async removeCookiePopups(page: Page): Promise<void> {
    const cookieSelectors = [
      '[class*="cookie"]',
      '[id*="cookie"]',
      '[class*="consent"]',
      '[id*="consent"]',
      '[class*="gdpr"]',
      '[id*="gdpr"]',
    ];

    for (const selector of cookieSelectors) {
      try {
        const elements = await page.$$(selector);
        for (const element of elements) {
          await element.evaluate((el) => el.remove());
        }
      } catch (error) {
        // 무시
      }
    }
  }

  private async extractPageData(
    page: Page,
    url: string,
    analysisId: string,
    screenshotsDir: string,
    htmlDir: string,
  ): Promise<CrawlResult> {
    const timestamp = new Date().toISOString();
    const urlHash = Buffer.from(url).toString('base64').replace(/[/+=]/g, '-');
    
    // 스크린샷 캡처
    const screenshotFileName = `${urlHash}-${timestamp.replace(/[:.]/g, '-')}.png`;
    const screenshotPath = path.join(screenshotsDir, screenshotFileName);
    await page.screenshot({ 
      path: screenshotPath, 
      fullPage: true,
      type: 'png'
    });

    // HTML 저장
    const htmlFileName = `${urlHash}-${timestamp.replace(/[:.]/g, '-')}.html`;
    const htmlPath = path.join(htmlDir, htmlFileName);
    const htmlContent = await page.content();
    await fs.promises.writeFile(htmlPath, htmlContent);

    // 데이터 추출
    const pageData = await page.evaluate(() => {
      const title = document.title || '';
      
      // 링크 추출
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => (a as HTMLAnchorElement).href)
        .filter(href => href && !href.startsWith('javascript:') && !href.startsWith('mailto:'));
      
      // 이미지 추출
      const images = Array.from(document.querySelectorAll('img[src]'))
        .map(img => (img as HTMLImageElement).src);
      
      // 제목 추출
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .map(h => ({
          level: h.tagName,
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
        textContent: textContent.substring(0, 1000) // 처음 1000자만
      };
    });

    // 페이지 타입 분류
    const pageType = this.classifyPageType(url, pageData.title, pageData.headings);

    return {
      url,
      title: pageData.title,
      pageType,
      links: pageData.links,
      images: pageData.images,
      headings: pageData.headings,
      forms: pageData.forms,
      textContent: pageData.textContent,
      screenshotPath: path.relative(process.cwd(), screenshotPath),
      htmlPath: path.relative(process.cwd(), htmlPath),
      timestamp,
    };
  }

  private classifyPageType(url: string, title: string, headings: any[]): string {
    const urlLower = url.toLowerCase();
    const titleLower = title.toLowerCase();
    const headingText = headings.map(h => h.text.toLowerCase()).join(' ');
    const allText = `${urlLower} ${titleLower} ${headingText}`;

    if (urlLower.includes('/') && urlLower.split('/').length <= 4) return 'homepage';
    if (allText.includes('about') || allText.includes('소개')) return 'about';
    if (allText.includes('contact') || allText.includes('연락') || allText.includes('문의')) return 'contact';
    if (allText.includes('product') || allText.includes('제품')) return 'product';
    if (allText.includes('service') || allText.includes('서비스')) return 'service';
    if (allText.includes('blog') || allText.includes('블로그') || allText.includes('news')) return 'blog';
    
    return 'other';
  }

  private generateNetworkData(results: CrawlResult[]): NetworkData {
    const nodes = results.map(result => ({
      id: result.url,
      label: result.title || new URL(result.url).pathname,
      color: this.getColorByPageType(result.pageType),
      type: result.pageType,
      url: result.url,
      title: result.title,
      screenshot: result.screenshotPath,
    }));

    const edges: Array<{ from: string; to: string }> = [];
    const urlSet = new Set(results.map(r => r.url));

    results.forEach(result => {
      result.links.forEach(link => {
        if (urlSet.has(link) && link !== result.url) {
          edges.push({
            from: result.url,
            to: link,
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
      service: '#FFEAA7',
      blog: '#DDA0DD',
      other: '#74B9FF',
    };
    return colors[pageType] || colors.other;
  }

  private generateVisualizationHtml(networkData: NetworkData, results: CrawlResult[]): string {
    return `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SiteMapper AI - 웹사이트 구조 분석</title>
    <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1a1a1a; color: #fff; }
        .container { display: flex; height: 100vh; }
        .map-container { flex: 1; position: relative; background: #2a2a2a; }
        #mynetworkid { width: 100%; height: 100%; }
        .sidebar { width: 400px; background: #333; padding: 20px; overflow-y: auto; }
        .controls { position: absolute; top: 20px; left: 20px; z-index: 1000; }
        .control-btn { 
            background: #4CAF50; color: white; border: none; padding: 10px 15px; 
            margin: 5px; border-radius: 5px; cursor: pointer; 
        }
        .control-btn:hover { background: #45a049; }
        .legend { position: absolute; top: 20px; right: 20px; background: rgba(0,0,0,0.8); padding: 15px; border-radius: 10px; }
        .legend-item { display: flex; align-items: center; margin: 5px 0; }
        .legend-color { width: 20px; height: 20px; border-radius: 50%; margin-right: 10px; }
        .page-info { background: #444; padding: 15px; border-radius: 10px; margin-bottom: 20px; }
        .screenshot { max-width: 100%; border-radius: 5px; margin: 10px 0; }
        .stats { background: #555; padding: 10px; border-radius: 5px; margin: 10px 0; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="map-container">
            <div id="mynetworkid"></div>
            <div class="controls">
                <button class="control-btn" onclick="network.fit()">전체 보기</button>
                <button class="control-btn" onclick="resetZoom()">줌 리셋</button>
                <button class="control-btn" onclick="exportImage()">이미지 저장</button>
            </div>
            <div class="legend">
                <h4>📋 페이지 타입</h4>
                <div class="legend-item"><div class="legend-color" style="background: #FF6B6B;"></div><span>홈페이지</span></div>
                <div class="legend-item"><div class="legend-color" style="background: #4ECDC4;"></div><span>소개</span></div>
                <div class="legend-item"><div class="legend-color" style="background: #45B7D1;"></div><span>연락처</span></div>
                <div class="legend-item"><div class="legend-color" style="background: #96CEB4;"></div><span>제품</span></div>
                <div class="legend-item"><div class="legend-color" style="background: #FFEAA7;"></div><span>서비스</span></div>
                <div class="legend-item"><div class="legend-color" style="background: #DDA0DD;"></div><span>블로그</span></div>
                <div class="legend-item"><div class="legend-color" style="background: #74B9FF;"></div><span>기타</span></div>
            </div>
        </div>
        <div class="sidebar">
            <h3>📄 페이지 정보</h3>
            <div id="page-details">
                <div class="page-info">
                    <p>노드를 클릭하여 페이지 정보를 확인하세요.</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        const networkData = ${JSON.stringify(networkData)};
        const resultsData = ${JSON.stringify(results)};
        
        const nodes = new vis.DataSet(networkData.nodes.map(node => ({
            ...node,
            shape: 'dot',
            size: 30,
            font: { color: '#ffffff', size: 14 },
            borderWidth: 2,
            borderColor: '#ffffff'
        })));
        
        const edges = new vis.DataSet(networkData.edges.map(edge => ({
            ...edge,
            color: { color: '#666666', highlight: '#ffffff' },
            width: 2,
            arrows: { to: { enabled: true, scaleFactor: 0.5 } }
        })));
        
        const container = document.getElementById('mynetworkid');
        const data = { nodes, edges };
        const options = {
            physics: {
                stabilization: { iterations: 100 },
                barnesHut: { gravitationalConstant: -2000, springLength: 200 }
            },
            interaction: { hover: true, selectConnectedEdges: false },
            layout: { randomSeed: 42 }
        };
        
        const network = new vis.Network(container, data, options);
        
        network.on('click', function(params) {
            if (params.nodes.length > 0) {
                const nodeId = params.nodes[0];
                const result = resultsData.find(r => r.url === nodeId);
                if (result) {
                    showPageDetails(result);
                }
            }
        });
        
        function showPageDetails(result) {
            const detailsDiv = document.getElementById('page-details');
            detailsDiv.innerHTML = \`
                <div class="page-info">
                    <h4>\${result.title}</h4>
                    <p><strong>URL:</strong> \${result.url}</p>
                    <p><strong>타입:</strong> \${result.pageType}</p>
                    <div class="stats">
                        📝 제목: \${result.headings.length}개 | 
                        🔗 링크: \${result.links.length}개 | 
                        🖼️ 이미지: \${result.images.length}개 | 
                        📋 폼: \${result.forms}개
                    </div>
                    <img src="\${result.screenshotPath}" class="screenshot" alt="스크린샷">
                    <h5>📝 제목들</h5>
                    <ul style="max-height: 120px; overflow-y: auto;">
                        \${result.headings.map(h => \`<li>[\${h.level}] \${h.text}</li>\`).join('')}
                    </ul>
                </div>
            \`;
        }
        
        function resetZoom() {
            network.moveTo({ scale: 1 });
        }
        
        function exportImage() {
            const canvas = container.querySelector('canvas');
            const link = document.createElement('a');
            link.download = 'website-map.png';
            link.href = canvas.toDataURL();
            link.click();
        }
    </script>
</body>
</html>
    `;
  }

  async getAnalysis(analysisId: string, userId: number) {
    return this.prisma.analysis.findFirst({
      where: {
        id: analysisId,
        userId,
      },
      include: {
        downloads: true,
      },
    });
  }

  async getUserAnalyses(userId: number) {
    return this.prisma.analysis.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
} 