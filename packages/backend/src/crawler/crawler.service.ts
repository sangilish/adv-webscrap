import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
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
    
    // 플랜별 페이지 제한 (FREE도 충분히 탐색 가능하도록 확대)
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
      headless: true
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1400, height: 900 }
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
        // 페이지 콘솔 에러 로깅
        page.on('pageerror', (err) => this.logger.error('Page error:', err));
        
        try {
          // ChatGPT 분석 반영: networkidle 타임아웃 문제 해결
          console.log(`🔍 Loading page: ${currentUrl}`);
          const response = await page.goto(currentUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
          });

          // 응답 상태 확인
          if (!response || !response.ok()) {
            console.log(`❌ Page load failed with status: ${response?.status()}`);
            continue;
          }

          // Curated.media WebSocket/SSE 지속 대응: networkidle 대신 DOM 로드 후 대기
          await page.waitForTimeout(3000);
          console.log(`✅ Page loaded and ready: ${currentUrl}`);

          // 디버깅: 페이지 내용 확인
          const pageTitle = await page.title();
          const pageContentLength = (await page.content()).length;
          console.log(`📊 Page Debug Info:`);
          console.log(`  - Title: "${pageTitle}"`);
          console.log(`  - Content Length: ${pageContentLength} chars`);
          console.log(`  - Response Status: ${response?.status()}`);

          // NEW: 고정 뷰포트 설정 (전체 페이지 스크린샷 안정화)
          await page.setViewportSize({ width: 1280, height: 800 });

          // SPA 네비게이션 탐지 (첫 번째 페이지에서만)
          if (results.length === 0) {
            console.log('🔍 Detecting SPA navigation patterns...');
            const spaRoutes = await this.detectSPANavigation(page, baseUrl);
            console.log(`🎯 Found ${spaRoutes.length} potential SPA routes`);
            
            // SPA 라우트를 크롤링 큐에 추가
            for (const route of spaRoutes) {
              if (!visitedUrls.has(route) && !urlsToVisit.includes(route)) {
                urlsToVisit.push(route);
                console.log(`➕ Added SPA route to queue: ${route}`);
              }
            }
          }

          // 데이터 추출
          const result = await this.crawlSinglePage(page, currentUrl, outputDir);
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
            const links = await this.extractLinks(page);
            
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
      const networkData = this.generateNetworkData(results, {});
      
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
    // 다양한 쿠키 팝업 selectors
    const cookieSelectors = [
      // Didomi 관련
      '[id="didomi-notice"]',
      '[class*="didomi"]',
      '#didomi-popup',
      '#didomi-banner',
      
      // 일반적인 쿠키 관련
      '[id*="cookie"]',
      '[class*="cookie"]',
      '[data-testid*="cookie"]',
      '[aria-label*="cookie"]',
      
      // Consent 관련
      '[id*="consent"]',
      '[class*="consent"]',
      '[data-testid*="consent"]',
      
      // GDPR 관련
      '[id*="gdpr"]',
      '[class*="gdpr"]',
      
      // Banner/Modal/Popup 관련
      '[class*="banner"]',
      '[class*="popup"]',
      '[class*="modal"]',
      '[class*="overlay"]',
      '[role="dialog"]',
      '[role="banner"]',
      
      // 특정 텍스트가 포함된 요소들
      'div:has-text("cookie")',
      'div:has-text("consent")',
      'div:has-text("privacy")',
      'div:has-text("accept")'
    ];

    // 먼저 모든 쿠키 관련 요소 제거
    for (const selector of cookieSelectors) {
      try {
        await page.waitForTimeout(500); // 팝업 로드 대기
        const elements = await page.$$(selector);
        for (const element of elements) {
          try {
            const isVisible = await element.isVisible();
            const boundingBox = await element.boundingBox();
            if (isVisible || boundingBox) {
              await element.evaluate((el) => {
                el.style.display = 'none !important';
                el.style.visibility = 'hidden !important';
                el.style.opacity = '0 !important';
                el.remove();
              });
            }
          } catch (e) {
            // 개별 요소 처리 실패 무시
          }
        }
      } catch (error) {
        // selector 처리 실패 무시
      }
    }

    // Accept/동의 버튼들 클릭 시도
    const acceptSelectors = [
      '#didomi-notice-agree-button',
      '#didomi-notice-agree-to-all',
      '.didomi-continue-without-agreeing',
      'button:has-text("Accept")',
      'button:has-text("Accept All")',
      'button:has-text("동의")',
      'button:has-text("모두 동의")',
      'button:has-text("OK")',
      'button:has-text("Got it")',
      'button:has-text("I understand")',
      '[class*="accept"]',
      '[id*="accept"]',
      '[data-testid*="accept"]'
    ];

    for (const selector of acceptSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          const isVisible = await button.isVisible();
          if (isVisible) {
            await button.click({ force: true });
            await page.waitForTimeout(1000);
            console.log(`Clicked cookie accept button: ${selector}`);
            break;
          }
        }
      } catch (error) {
        // 버튼 클릭 실패 무시
      }
    }

    // CSS로 강제 숨김 처리
    await page.addStyleTag({
      content: `
        [id*="didomi"],
        [class*="didomi"],
        [id*="cookie"],
        [class*="cookie"],
        [id*="consent"],
        [class*="consent"],
        [id*="gdpr"],
        [class*="gdpr"] {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          height: 0 !important;
          width: 0 !important;
          z-index: -9999 !important;
        }
      `
    });

    // 추가 대기 시간으로 팝업 완전 제거 확인
    await page.waitForTimeout(2000);
  }

  private async crawlSinglePage(page: Page, url: string, outputDir: string): Promise<CrawlResult> {
    const timestamp = new Date().toISOString();
    const pageId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log(`🚀 페이지 로딩 시작: ${url}`);
    
    // Enable console logging from the page
    page.on('console', msg => {
      console.log(`[PAGE ${msg.type().toUpperCase()}] ${msg.text()}`);
    });
    
    // Navigate to the page first!
    await page.goto(url, { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });

    console.log(`📄 페이지 로드 완료, SPA 렌더링 대기 중...`);

    // Wait for the page to be fully interactive
    await page.waitForLoadState('networkidle').catch(() => {
      console.log('⚠️ 네트워크 idle 대기 실패, DOM 로드로 대체');
      return page.waitForLoadState('domcontentloaded');
    });
    
    // Give SPAs extra time to render - curated.media needs more time
    console.log(`⏳ SPA 렌더링을 위해 5초 대기...`);
    await page.waitForTimeout(5000);

    // Remove cookie popups only for full analysis (프리뷰에서는 생략)
    const isPreviewRun = path.basename(outputDir).startsWith('preview_');
    if (!isPreviewRun) {
      console.log(`🍪 쿠키 팝업 및 오버레이 제거 중...`);
      await this.removeCookiePopups(page);
      await page.waitForTimeout(1000);
    }

    // Try to trigger any lazy-loaded content
    console.log(`📜 스크롤하여 지연 로딩 컨텐츠 트리거...`);
    await page.evaluate(() => {
      // Scroll to trigger lazy loading
      window.scrollTo(0, document.body.scrollHeight);
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    // Screenshot
    const screenshotFilename = `${pageId}.png`;
    const screenshotsDir = path.join(outputDir, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    const screenshotPath = path.join(screenshotsDir, screenshotFilename);
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      type: 'png'
    });

    // HTML content
    const htmlContent = await page.content();
    const htmlFilename = `${pageId}.html`;
    const htmlDir = path.join(outputDir, 'html');
    if (!fs.existsSync(htmlDir)) {
      fs.mkdirSync(htmlDir, { recursive: true });
    }
    const htmlPath = path.join(htmlDir, htmlFilename);
    await fs.promises.writeFile(htmlPath, htmlContent);

    // Extract all possible navigation targets
    console.log(`🔍 링크 추출 시작: ${url}`);
    
    const navigationData = await page.evaluate(() => {
      const currentOrigin = location.origin;

      // 1) 모든 a[href] 절대 URL 모으기
      const rawLinks = Array.from(document.querySelectorAll('a[href]'))
        .map(a => (a as HTMLAnchorElement).href.trim())
        .filter(h => h &&
                    !h.startsWith('javascript:') &&
                    !h.startsWith('mailto:') &&
                    !h.startsWith('tel:'));

      // 2) 같은 Origin 만 필터 & 중복 제거
      const links = Array.from(new Set(
        rawLinks.filter(h => {
          try { return new URL(h).origin === currentOrigin; } catch { return false; }
        })
      ));

      // 기본 페이지 메타 데이터
      const images = Array.from(document.querySelectorAll('img[src]'))
        .map(img => (img as HTMLImageElement).src)
        .filter(src => src && !src.startsWith('data:'));

      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .map(h => ({ level: h.tagName.toLowerCase(), text: h.textContent?.trim() || '' }))
        .filter(h => h.text);

      const forms = document.querySelectorAll('form').length;
      const buttonTexts = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"]'))
        .map(btn => btn.textContent?.trim() || btn.getAttribute('value') || '')
        .filter(t => t);

      return {
        title: document.title || '',
        links,
        allLinks: rawLinks,
        images,
        headings,
        forms,
        textContent: document.body?.innerText || '',
        buttons: buttonTexts,
        debugInfo: [] as any[]
      };
    });

    // Log debug information
    console.log(`\n🔍 Link Extraction Debug for ${url}:`);
    console.log(`Found ${navigationData.links.length} valid links`);
    console.log(`Total links discovered: ${navigationData.allLinks ? navigationData.allLinks.length : 0}`);
    
    // Temporary: Add debug info to textContent for inspection
    let debugText = `\n\n=== DEBUG INFO ===\n`;
    debugText += `Total links found: ${navigationData.links.length}\n`;
    debugText += `All links discovered: ${navigationData.allLinks ? navigationData.allLinks.length : 0}\n`;
    debugText += `Debug entries: ${navigationData.debugInfo ? navigationData.debugInfo.length : 0}\n`;
    
    if (navigationData.allLinks) {
      debugText += `\nAll discovered links:\n`;
      navigationData.allLinks.slice(0, 10).forEach(link => debugText += `  - ${link}\n`);
      if (navigationData.allLinks.length > 10) {
        debugText += `  ... and ${navigationData.allLinks.length - 10} more\n`;
      }
    }
    
    if (navigationData.debugInfo) {
      const accepted = navigationData.debugInfo.filter(d => d.accepted);
      const rejected = navigationData.debugInfo.filter(d => !d.accepted);
      
      debugText += `\nAccepted: ${accepted.length} links\n`;
      accepted.slice(0, 5).forEach(d => debugText += `  - ${d.url} (${d.source})\n`);
      
      debugText += `\nRejected: ${rejected.length} links\n`;
      const rejectionReasons = rejected.reduce((acc, d) => {
        acc[d.rejected] = (acc[d.rejected] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      Object.entries(rejectionReasons).forEach(([reason, count]) => {
        debugText += `  - ${reason}: ${count} links\n`;
      });
      
      // Add first few rejected links for inspection
      debugText += `\nFirst few rejected:\n`;
      rejected.slice(0, 5).forEach(d => debugText += `  - ${d.url} (${d.rejected}, ${d.source})\n`);
    }
    
    // Append debug info to textContent temporarily
    navigationData.textContent += debugText;
    
    if (navigationData.debugInfo) {
      const accepted = navigationData.debugInfo.filter(d => d.accepted);
      const rejected = navigationData.debugInfo.filter(d => !d.accepted);
      
      console.log(`✅ Accepted: ${accepted.length} links`);
      accepted.slice(0, 5).forEach(d => console.log(`  - ${d.url} (${d.source})`));
      
      console.log(`❌ Rejected: ${rejected.length} links`);
      const rejectionReasons = rejected.reduce((acc, d) => {
        acc[d.rejected] = (acc[d.rejected] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      Object.entries(rejectionReasons).forEach(([reason, count]) => {
        console.log(`  - ${reason}: ${count} links`);
      });
    }

         // Page type classification
     let pageType = '일반페이지';
     const pathname = new URL(url).pathname.toLowerCase();
     const titleLower = navigationData.title.toLowerCase();
     
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
     } else if (pathname.includes('dashboard') || titleLower.includes('dashboard')) {
       pageType = '대시보드';
     }

    const isPreview = path.basename(outputDir).startsWith('preview_');
    const screenshotUrl = isPreview
      ? `/temp/${path.basename(outputDir)}/screenshots/${screenshotFilename}`
      : `/uploads/${path.basename(outputDir)}/screenshots/${screenshotFilename}`;
    const htmlUrl = isPreview
      ? `/temp/${path.basename(outputDir)}/html/${htmlFilename}`
      : `/uploads/${path.basename(outputDir)}/html/${htmlFilename}`;

    // Add debugging info
    console.log(`📊 Navigation data:`, {
      title: navigationData.title,
      linksFound: navigationData.links.length,
      debugEntries: navigationData.debugInfo?.length || 0
    });
    
    const result: CrawlResult = {
      id: pageId,
      url,
      title: `${navigationData.title} [LINKS: ${navigationData.links.length}]`,
      pageType,
      links: navigationData.links,
      images: navigationData.images,
      headings: navigationData.headings,
      forms: navigationData.forms,
      buttons: navigationData.buttons,
      textContent: navigationData.textContent + `\n\n=== DEBUG ===\nLinks found: ${navigationData.links.length}\nDebug entries: ${navigationData.debugInfo?.length || 0}`,
      screenshotPath: screenshotUrl,
      htmlPath: htmlUrl,
      timestamp,
      metadata: {
        wordCount: navigationData.textContent.split(/\s+/).length,
        imageCount: navigationData.images.length,
        linkCount: navigationData.links.length
      }
    };

    return result;
  }

  private async extractLinks(page: Page): Promise<string[]> {
    const base = new URL(page.url()).origin;

    // 1) 메뉴(사이드바)가 렌더될 때까지 기다리기
    await page.waitForSelector('nav, .sidebar, [role="menu"]', { timeout: 5000 }).catch(() => {});

    // 2) 모든 <a> 태그의 절대 URL
    const anchors = await page.$$eval('a[href]', els =>
      els
        .map(a => (a as HTMLAnchorElement).href)
        .filter(href => href.startsWith(window.location.origin) &&
                        !/(javascript:|mailto:|tel:)/.test(href) &&
                        !/\.(css|js|png|jpg|jpeg|gif|svg|ico|pdf|zip|mp4|mp3)([?#]|$)/i.test(href))
    );

    // 3) onclick 속성으로 네비게이션 하는 버튼
    const btns = await page.$$eval('button[onclick]', els =>
      els
        .map(b => {
          const m = b.getAttribute('onclick')?.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
          return m ? new URL(m[1], window.location.href).href : null;
        })
        .filter((u): u is string => !!u && u.startsWith(window.location.origin))
    );

    // 4) data-href / data-url 속성
    const dataLinks = await page.$$eval('[data-href],[data-url]', els =>
      els
        .map(el => el.getAttribute('data-href') || el.getAttribute('data-url'))
        .map(url => url ? new URL(url, window.location.href).href : null)
        .filter((u): u is string => !!u && u.startsWith(window.location.origin))
    );

    // 5) 실제 클릭으로 라우팅되는 링크 (SPA)
    const clickItems = await page.$$('nav button, nav li, [role="menuitem"]');
    const clickLinks: string[] = [];
    for (const item of clickItems) {
      try {
        const before = page.url();
        await item.click();
        await page.waitForLoadState('networkidle');
        const after = page.url();
        if (after !== before && after.startsWith(base)) {
          clickLinks.push(after);
        }
        // 뒤로 돌아가기
        await page.goBack({ waitUntil: 'networkidle' });
      } catch {
        // 클릭 실패해도 무시
      } finally {
        await page.waitForTimeout(500);
      }
    }

    // 6) 모두 합쳐서 중복 제거
    const all = [...anchors, ...btns, ...dataLinks, ...clickLinks];
    return Array.from(new Set(all));
  }

  private generateNetworkData(results: CrawlResult[], sitemap: Record<string, string[]>): NetworkData {
    const nodes: NetworkNode[] = [];
    const edges: NetworkEdge[] = [];
    const processedUrls = new Set<string>();
    
    results.forEach((result, index) => {
      if (!processedUrls.has(result.url)) {
        processedUrls.add(result.url);
        
        // Determine node color based on page type
        let color = '#6366f1'; // Default purple
        switch (result.pageType) {
          case '홈페이지': color = '#ef4444'; break;
          case '소개페이지': color = '#10b981'; break;
          case '연락처': color = '#f59e0b'; break;
          case '제품페이지': color = '#8b5cf6'; break;
          case '서비스페이지': color = '#06b6d4'; break;
          case '대시보드': color = '#ec4899'; break;
        }
        
        nodes.push({
          id: result.id,
          label: result.title.substring(0, 20) + (result.title.length > 20 ? '...' : ''),
          color,
          type: result.pageType,
          url: result.url,
          title: result.title,
          screenshot: result.screenshotPath
        });
      }
    });
    
    // Generate edges from sitemap
    Object.entries(sitemap).forEach(([parentUrl, childUrls]) => {
      const parentResult = results.find(r => r.url === parentUrl);
      if (parentResult) {
        childUrls.forEach(childUrl => {
          const childResult = results.find(r => r.url === childUrl);
          if (childResult) {
            edges.push({
              from: parentResult.id,
              to: childResult.id
            });
          }
        });
      }
    });
    
    return { nodes, edges };
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

  // 유틸리티 함수들
  private sanitizeFilename(url: string): string {
    return url.replace(/[^0-9a-zA-Z]+/g, '_').slice(0, 200);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private randomDelay(min: number = 1000, max: number = 3000): number {
    return Math.random() * (max - min) + min;
  }

  private isSameDomain(url: string, baseUrl: string): boolean {
    try {
      const urlObj = new URL(url);
      const baseUrlObj = new URL(baseUrl);
      return urlObj.hostname === baseUrlObj.hostname;
    } catch {
      return false;
    }
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
  async getPreviewAnalysis(url: string): Promise<AnalysisResult> {
    this.logger.log(`Starting preview analysis for: ${url}`);
    
    try {
      // Validate URL
      new URL(url);
      
      // Perform DFS crawl with preview limits
      const { results, sitemap } = await this.performDFSCrawl(url, 2, 5); // depth=2, max=5 pages for preview
      
      // Generate network data
      const networkData = this.generateNetworkData(results, sitemap);
      
      return {
        results,
        networkData,
        totalPages: results.length,
        isPreview: true,
        previewLimit: 5,
        message: `미리보기로 ${results.length}개 페이지를 분석했습니다. 전체 분석을 원하시면 로그인해주세요.`
      };
      
    } catch (error) {
      this.logger.error(`Preview analysis failed for ${url}:`, error);
      throw error;
    }
  }

  private async performDFSCrawl(
    startUrl: string, 
    maxDepth: number = 3, 
    maxPages: number = 5
  ): Promise<{ results: CrawlResult[], sitemap: Record<string, string[]> }> {
    
    // Create output directory
    const timestamp = Date.now();
    const outputDir = path.join(process.cwd(), 'temp', `preview_${timestamp}`);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    
    try {
      // Launch browser
      browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
      });
      
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        viewport: { width: 1400, height: 900 }
      });
      
      const page = await context.newPage();
      
      const visited = new Set<string>();
      const sitemap: Record<string, string[]> = {};
      const results: CrawlResult[] = [];
      
      // DFS crawling function
      const dfs = async (url: string, depth: number): Promise<void> => {
        if (depth > maxDepth || visited.has(url) || results.length >= maxPages) {
          this.logger.log(`⏭️  Skipping ${url} - depth:${depth}/${maxDepth}, visited:${visited.has(url)}, results:${results.length}/${maxPages}`);
          return;
        }
        
        this.logger.log(`🔍 [DEPTH ${depth}] Starting crawl: ${url}`);
        visited.add(url);
        
        try {
          // Navigate to the page
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(3000);
          
          // SPA 네비게이션 탐지 (첫 번째 페이지에서만)
          if (depth === 0) {
            console.log('🔍 Detecting SPA navigation patterns...');
            const spaRoutes = await this.detectSPANavigation(page, new URL(startUrl).origin);
            console.log(`🎯 Found ${spaRoutes.length} potential SPA routes`);
            
            // SPA 라우트를 방문 목록에 추가
            for (const route of spaRoutes) {
              if (!visited.has(route)) {
                visited.add(route);
                console.log(`➕ Added SPA route: ${route}`);
              }
            }
          }
          
          const result = await this.crawlSinglePage(page, url, outputDir);
          results.push(result);
          
          this.logger.log(`✅ [DEPTH ${depth}] Crawled successfully: ${url} (found ${result.links.length} links)`);
          
          // Filter same-domain links
          const childLinks = result.links.filter(link => this.isSameDomain(link, startUrl));
          sitemap[url] = childLinks;
          
          this.logger.log(`🔗 [DEPTH ${depth}] Same-domain child links: ${childLinks.length}`);
          childLinks.forEach((link, index) => {
            this.logger.log(`   ${index + 1}. ${link}`);
          });
          
          // Recursively crawl child links
          for (const childUrl of childLinks) {
            if (results.length >= maxPages) {
              this.logger.log(`🛑 Reached max pages limit (${maxPages})`);
              break;
            }
            
            if (!visited.has(childUrl)) {
              this.logger.log(`⏳ [DEPTH ${depth}] Preparing to crawl child: ${childUrl}`);
              
              // Random delay between requests
              const delay = this.randomDelay(1000, 3000);
              this.logger.log(`⏰ Waiting ${Math.round(delay)}ms before next crawl...`);
              await this.sleep(delay);
              
              await dfs(childUrl, depth + 1);
            } else {
              this.logger.log(`⏭️  Already visited: ${childUrl}`);
            }
          }
          
        } catch (error) {
          this.logger.warn(`❌ [DEPTH ${depth}] Failed to crawl ${url}: ${error.message}`);
          sitemap[url] = [];
        }
      };
      
      // Start DFS from root URL
      await dfs(startUrl, 0);
      
      // Save sitemap
      const sitemapPath = path.join(outputDir, 'sitemap.json');
      fs.writeFileSync(sitemapPath, JSON.stringify(sitemap, null, 2));
      
      this.logger.log(`Crawl finished - ${results.length} pages crawled`);
      
      return { results, sitemap };
      
    } finally {
      if (context) await context.close();
      if (browser) await browser.close();
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

  // Add SPA detection method
  private async detectSPANavigation(page: Page, baseUrl: string): Promise<string[]> {
    const discoveredUrls = new Set<string>();
    
    console.log('🔍 Detecting SPA navigation patterns...');
    
    // Method 1: Intercept navigation requests
    page.on('request', request => {
      const url = request.url();
      const resourceType = request.resourceType();
      
      // Look for API calls that might indicate routes
      if ((resourceType === 'xhr' || resourceType === 'fetch') && url.startsWith(baseUrl)) {
        console.log(`🌐 Detected API call: ${url}`);
        
        // Extract potential routes from API paths
        try {
          const urlObj = new URL(url);
          const pathSegments = urlObj.pathname.split('/').filter(s => s);
          
          // Common patterns: /api/pages/*, /api/*/list, etc.
          if (pathSegments.includes('pages') || pathSegments.includes('routes')) {
            discoveredUrls.add(url);
          }
        } catch (e) {
          // Invalid URL
        }
      }
    });
    
    // Method 2: Monitor for client-side route changes
    await page.evaluate(() => {
      // Intercept History API
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      
      history.pushState = function(...args) {
        console.log('🔀 pushState:', args[2]);
        window.postMessage({ type: 'navigation', url: args[2] }, '*');
        return originalPushState.apply(history, args);
      };
      
      history.replaceState = function(...args) {
        console.log('🔀 replaceState:', args[2]);
        window.postMessage({ type: 'navigation', url: args[2] }, '*');
        return originalReplaceState.apply(history, args);
      };
    });
    
    // Listen for navigation messages
    await page.exposeFunction('onNavigation', (url: string) => {
      if (url && url.startsWith('/')) {
        discoveredUrls.add(new URL(url, baseUrl).href);
      }
    });
    
    await page.evaluate(() => {
      window.addEventListener('message', (e) => {
        if (e.data.type === 'navigation' && e.data.url) {
          (window as any).onNavigation(e.data.url);
        }
      });
    });
    
    // Method 3: Extract routes from JavaScript
    const jsRoutes = await page.evaluate(() => {
      const routes = new Set<string>();
      
      // Look for Next.js routes
      if ((window as any).__NEXT_DATA__) {
        const nextData = (window as any).__NEXT_DATA__;
        console.log('🔷 Found Next.js data:', nextData);
        
        // Extract page paths
        if (nextData.page) routes.add(nextData.page);
        if (nextData.props?.pageProps?.href) routes.add(nextData.props.pageProps.href);
        
        // Look for route manifest
        if (nextData.runtimeConfig?.routes) {
          Object.values(nextData.runtimeConfig.routes).forEach((route: any) => {
            if (typeof route === 'string') routes.add(route);
          });
        }
      }
      
      // Look for React Router
      if ((window as any).__reactRouterVersion) {
        console.log('⚛️ Found React Router');
        
        // Try to find route configuration
        const routerElements = document.querySelectorAll('[data-route], [data-path]');
        routerElements.forEach(el => {
          const route = el.getAttribute('data-route') || el.getAttribute('data-path');
          if (route) routes.add(route);
        });
      }
      
      // Look for Vue Router
      if ((window as any).$nuxt || (window as any).__VUE__) {
        console.log('🟢 Found Vue/Nuxt');
        
        // Extract routes from Vue Router
        try {
          const app = (window as any).__VUE__ || (window as any).$nuxt;
          if (app.$router && app.$router.options && app.$router.options.routes) {
            app.$router.options.routes.forEach((route: any) => {
              if (route.path) routes.add(route.path);
            });
          }
        } catch (e) {
          console.error('Error extracting Vue routes:', e);
        }
      }
      
      return Array.from(routes);
    });
    
    jsRoutes.forEach(route => {
      try {
        const fullUrl = new URL(route, baseUrl);
        discoveredUrls.add(fullUrl.href);
      } catch (e) {
        // Invalid URL
      }
    });
    
    // Method 4: Click on navigation elements
    const navSelectors = [
      'nav a',
      'nav button',
      '[role="navigation"] a',
      '[role="navigation"] button',
      '.nav-link',
      '.nav-item',
      'a[class*="nav"]',
      'button[class*="nav"]',
      '[data-testid*="nav"]',
      '[aria-label*="navigation"]'
    ];
    
    for (const selector of navSelectors) {
      const elements = await page.$$(selector);
      console.log(`🖱️ Found ${elements.length} elements matching ${selector}`);
      
      for (const element of elements.slice(0, 5)) { // Limit to prevent too many clicks
        try {
          const isVisible = await element.isVisible();
          if (!isVisible) continue;
          
          const beforeUrl = page.url();
          
          // Hover first (might trigger dropdowns)
          await element.hover();
          await page.waitForTimeout(500);
          
          // Try to click
          await element.click({ timeout: 2000 });
          await page.waitForTimeout(1000);
          
          const afterUrl = page.url();
          if (afterUrl !== beforeUrl && afterUrl.startsWith(baseUrl)) {
            discoveredUrls.add(afterUrl);
            console.log(`✅ Discovered via click: ${afterUrl}`);
            
            // Go back
            await page.goBack({ waitUntil: 'domcontentloaded' });
          }
        } catch (e) {
          // Click failed, continue
        }
      }
    }
    
    console.log(`🎯 Found ${discoveredUrls.size} potential SPA routes`);
    discoveredUrls.forEach((route, i) => console.log(`  ${i + 1}. ${route}`));
    
    return Array.from(discoveredUrls);
  }
}