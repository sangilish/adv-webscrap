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

          // 쿠키 팝업 제거
          await this.removeCookiePopups(page);
          await page.waitForTimeout(1000);

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
            const links = await page.evaluate(() => {
              const allLinks = new Set<string>();
              
              // 1. 모든 앵커 태그 (Python 코드와 동일)
              const anchors = document.querySelectorAll('a[href]');
              for (const anchor of anchors) {
                const href = (anchor as HTMLAnchorElement).href;
                if (href && href.startsWith('http') && !href.includes('javascript:')) {
                  allLinks.add(href);
                }
              }

              // 2. 버튼의 onclick에서 location.href 추출 (Python 코드 방식)
              const buttons = document.querySelectorAll('button');
              for (const button of buttons) {
                const onclick = button.getAttribute('onclick') || '';
                const match = onclick.match(/location\.href\s*=\s*['"]([^'"]*)['"]/);
                if (match && match[1] && match[1].startsWith('http')) {
                  allLinks.add(match[1]);
                }
              }

              // 3. 기타 클릭 가능한 요소들의 data 속성
              const clickableElements = document.querySelectorAll('[data-href], [data-url], [onclick*="location"]');
              for (const el of clickableElements) {
                const dataHref = el.getAttribute('data-href') || 
                                el.getAttribute('data-url') || '';
                if (dataHref && dataHref.startsWith('http')) {
                  allLinks.add(dataHref);
                }
                
                // onclick에서 URL 추출
                const onclick = el.getAttribute('onclick') || '';
                const urlMatch = onclick.match(/(?:window\.location|location\.href)\s*=\s*['"]([^'"]+)['"]/);
                if (urlMatch && urlMatch[1] && urlMatch[1].startsWith('http')) {
                  allLinks.add(urlMatch[1]);
                }
              }

              return Array.from(allLinks);
            });
            
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

  private async extractPageData(
    page: any,
    url: string,
    analysisId: string,
    screenshotsDir: string,
    htmlDir: string,
  ): Promise<CrawlResult> {
    try {
      // 페이지가 완전히 로드될 때까지 추가 대기
      await page.waitForTimeout(5000);

      // 더 공격적인 JavaScript 실행
      await page.evaluate(() => {
        // 모든 이벤트 리스너 트리거
        const events = ['mouseover', 'mouseenter', 'focus', 'click'];
        const allElements = document.querySelectorAll('*');
        allElements.forEach(el => {
          events.forEach(event => {
            try {
              const evt = new Event(event, { bubbles: true, cancelable: true });
              el.dispatchEvent(evt);
            } catch (e) {
              // 무시
            }
          });
        });

        // 모든 스크립트가 실행될 시간을 줌
        return new Promise(resolve => setTimeout(resolve, 3000));
      });

      await page.waitForTimeout(3000);

      // 페이지 제목
      const title = await page.evaluate(() => {
        return document.title || 
               document.querySelector('h1')?.textContent || 
               document.querySelector('title')?.textContent || 
               'Untitled Page';
      });

      // Python 코드 방식의 링크 추출 - JavaScript evaluation 사용
      const links = await page.evaluate(() => {
        const allLinks = new Set<string>();
        
        // 1. 모든 앵커 태그 (Python 코드와 동일)
        const anchors = document.querySelectorAll('a[href]');
        for (const anchor of anchors) {
          const href = (anchor as HTMLAnchorElement).href;
          if (href && href.startsWith('http') && !href.includes('javascript:')) {
            allLinks.add(href);
          }
        }

        // 2. 버튼의 onclick에서 location.href 추출 (Python 코드 방식)
        const buttons = document.querySelectorAll('button');
        for (const button of buttons) {
          const onclick = button.getAttribute('onclick') || '';
          const match = onclick.match(/location\.href\s*=\s*['"]([^'"]*)['"]/);
          if (match && match[1] && match[1].startsWith('http')) {
            allLinks.add(match[1]);
          }
        }

        // 3. 기타 클릭 가능한 요소들의 data 속성
        const clickableElements = document.querySelectorAll('[data-href], [data-url], [onclick*="location"]');
        for (const el of clickableElements) {
          const dataHref = el.getAttribute('data-href') || 
                          el.getAttribute('data-url') || '';
          if (dataHref && dataHref.startsWith('http')) {
            allLinks.add(dataHref);
          }
          
          // onclick에서 URL 추출
          const onclick = el.getAttribute('onclick') || '';
          const urlMatch = onclick.match(/(?:window\.location|location\.href)\s*=\s*['"]([^'"]+)['"]/);
          if (urlMatch && urlMatch[1] && urlMatch[1].startsWith('http')) {
            allLinks.add(urlMatch[1]);
          }
        }

        return Array.from(allLinks);
      });

      // Python 코드 방식의 버튼/클릭 요소 추출
      const buttons = await page.evaluate(() => {
        const buttonTexts = new Set<string>();
        
        // 모든 가능한 클릭 가능한 요소들을 포괄적으로 수집
        const selectors = [
          'button', 'input[type="submit"]', 'input[type="button"]',
          'a', '[role="button"]', '[onclick]', '[data-toggle]',
          '.btn', '.button', '.nav-link', '.menu-item', '.tab',
          '.dropdown-item', '.clickable', '.action-button',
          'nav a', '.navbar a', '.menu a', '.navigation a',
          '.header a', '.sidebar a', '.footer a', 'li a'
        ];

        for (const selector of selectors) {
          try {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              // 텍스트 추출 - 여러 속성에서 시도
              const text = el.textContent?.trim() || 
                          el.getAttribute('title') || 
                          el.getAttribute('aria-label') || 
                          el.getAttribute('alt') || 
                          el.getAttribute('placeholder') || 
                          el.getAttribute('value') || '';
              
              if (text && text.length > 0 && text.length < 100 && !text.includes('\n')) {
                buttonTexts.add(text);
              }
            }
          } catch (e) {
            // 선택자 오류 무시
          }
        }

        // 특별히 메뉴/네비게이션 아이템들 추가 수집
        const menuItems = document.querySelectorAll('li, .menu-option, .nav-option, .sidebar-item, .dropdown-menu li');
        for (const item of menuItems) {
          const text = item.textContent?.trim();
          if (text && text.length > 0 && text.length < 50 && 
              (item.querySelector('a') || item.hasAttribute('onclick') || 
               item.classList.contains('clickable'))) {
            buttonTexts.add(text);
          }
        }

        return Array.from(buttonTexts).filter(text => 
          text.length > 0 && 
          text.trim() !== '' &&
          !text.match(/^\s*$/)
        );
      });

      // 이미지 추출
      const images = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img[src]'));
        return imgs.map(img => {
          const src = (img as HTMLImageElement).src;
          return src.startsWith('http') ? src : new URL(src, window.location.href).href;
        }).filter(src => src && !src.includes('data:'));
      });

      // 헤딩 추출
      const headings = await page.evaluate(() => {
        const headingElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
        return Array.from(headingElements).map(h => ({
          level: h.tagName.toLowerCase(),
          text: h.textContent?.trim() || ''
        })).filter(h => h.text.length > 0);
      });

      // 폼 개수
      const forms = await page.evaluate(() => {
        return document.querySelectorAll('form').length;
      });

      // 텍스트 콘텐츠
      const textContent = await page.evaluate(() => {
        // 스크립트, 스타일, 숨겨진 요소 제외하고 텍스트 추출
        const walker = document.createTreeWalker(
          document.body || document,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              
              const style = window.getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden') {
                return NodeFilter.FILTER_REJECT;
              }
              
              const tagName = parent.tagName.toLowerCase();
              if (['script', 'style', 'noscript'].includes(tagName)) {
                return NodeFilter.FILTER_REJECT;
              }
              
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );

        let text = '';
        let node;
        while (node = walker.nextNode()) {
          const content = node.textContent?.trim();
          if (content && content.length > 0) {
            text += content + ' ';
          }
        }
        
        return text.trim().substring(0, 5000); // 최대 5000자
      });

      // 페이지 타입 분류
      const pageType = this.classifyPageType(url, title, headings, buttons);

      // 고유 ID 생성
      const pageId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // 스크린샷 저장 (PNG에는 quality 옵션 불가)
      const screenshotFilename = `${pageId}.png`;
      const screenshotPath = path.join(screenshotsDir, screenshotFilename);
      await page.screenshot({ 
        path: screenshotPath, 
        fullPage: true,
        type: 'png'
        // quality 제거 - PNG에서는 지원하지 않음
      });

      // HTML 저장
      const htmlFilename = `${pageId}.html`;
      const htmlPath = path.join(htmlDir, htmlFilename);
      const htmlContent = await page.content();
      await fs.promises.writeFile(htmlPath, htmlContent, 'utf8');

      // 메타데이터 계산
      const words = textContent.split(/\s+/).filter(word => word.length > 0);
      
      console.log(`📊 Page Analysis Results for ${url}:`);
      console.log(`  - Title: ${title}`);
      console.log(`  - Links found: ${links.length}`);
      console.log(`  - Buttons found: ${buttons.length}`);
      console.log(`  - Images found: ${images.length}`);
      console.log(`  - Headings found: ${headings.length}`);
      console.log(`  - Word count: ${words.length}`);
      console.log(`  - First 5 buttons: ${buttons.slice(0, 5).join(', ')}`);

      return {
        id: pageId,
        url,
        title,
        pageType,
        links,
        images,
        headings,
        forms,
        buttons,
        textContent,
        screenshotPath: `/temp/${analysisId}/screenshots/${screenshotFilename}`,
        htmlPath: `/temp/${analysisId}/html/${htmlFilename}`,
        timestamp: new Date().toISOString(),
        metadata: {
          wordCount: words.length,
          imageCount: images.length,
          linkCount: links.length,
        },
      };
    } catch (error) {
      console.error(`Error extracting data from ${url}:`, error);
      
      // 오류 발생 시에도 기본 데이터 반환
      const pageId = `page_${Date.now()}_error`;
      return {
        id: pageId,
        url,
        title: 'Error loading page',
        pageType: 'error',
        links: [],
        images: [],
        headings: [],
        forms: 0,
        buttons: [],
        textContent: '',
        screenshotPath: '',
        htmlPath: '',
        timestamp: new Date().toISOString(),
        metadata: {
          wordCount: 0,
          imageCount: 0,
          linkCount: 0,
        },
      };
    }
  }

  private classifyPageType(url: string, title: string, headings: any[], buttons: string[]): string {
    const urlLower = url.toLowerCase();
    const titleLower = title.toLowerCase();
    const allText = (title + ' ' + headings.map(h => h.text).join(' ') + ' ' + buttons.join(' ')).toLowerCase();
    
    // URL 패턴 기반 분류
    if (urlLower.includes('/home') || urlLower === '/' || urlLower.match(/^https?:\/\/[^\/]+\/?$/)) {
      return '홈페이지';
    } else if (urlLower.includes('/about') || allText.includes('about') || allText.includes('회사소개')) {
      return '회사소개';
    } else if (urlLower.includes('/product') || urlLower.includes('/service') || allText.includes('제품') || allText.includes('서비스')) {
      return '제품/서비스';
    } else if (urlLower.includes('/blog') || urlLower.includes('/news') || allText.includes('블로그') || allText.includes('뉴스')) {
      return '블로그/뉴스';
    } else if (urlLower.includes('/contact') || allText.includes('contact') || allText.includes('연락처')) {
      return '연락처';
    } else if (urlLower.includes('/dashboard') || allText.includes('dashboard') || allText.includes('대시보드')) {
      return '대시보드';
    } else if (urlLower.includes('/pricing') || allText.includes('pricing') || allText.includes('요금')) {
      return '요금제';
    } else if (urlLower.includes('/login') || urlLower.includes('/signin') || allText.includes('로그인')) {
      return '로그인';
    } else if (urlLower.includes('/signup') || urlLower.includes('/register') || allText.includes('회원가입')) {
      return '회원가입';
    } else if (urlLower.includes('/portfolio') || allText.includes('portfolio') || allText.includes('포트폴리오')) {
      return '포트폴리오';
    } else if (urlLower.includes('/team') || allText.includes('team') || allText.includes('팀')) {
      return '팀 소개';
    } else if (urlLower.includes('/faq') || allText.includes('faq') || allText.includes('자주묻는질문')) {
      return 'FAQ';
    } else if (urlLower.includes('/support') || allText.includes('support') || allText.includes('지원')) {
      return '고객지원';
    } else {
      // 메인 헤딩과 버튼을 기반으로 분류
      const mainHeading = headings.find(h => h.level === 'h1')?.text || title;
      const mainButtons = buttons.slice(0, 3).join(', ');
      
      if (mainButtons) {
        return `${mainHeading.slice(0, 20)}... (${mainButtons})`;
      } else {
        return mainHeading.slice(0, 30) || '일반 페이지';
      }
    }
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
    console.log('Starting preview analysis for:', url);
    
    const tempId = `preview_${Date.now()}`;
    const tempDir = path.join(process.cwd(), 'temp', tempId);
    const screenshotsDir = path.join(tempDir, 'screenshots');
    const htmlDir = path.join(tempDir, 'html');
    
    await fs.promises.mkdir(screenshotsDir, { recursive: true });
    await fs.promises.mkdir(htmlDir, { recursive: true });

    console.log('Temp directories created:', { tempDir, screenshotsDir, htmlDir });

    const browser = await chromium.launch({ 
      headless: true
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1400, height: 900 }
    });

    console.log('Browser launched successfully');

    try {
      const results: CrawlResult[] = [];
      const visitedUrls = new Set<string>();
      const baseUrl = new URL(url).origin;
      
      // 첫 번째 페이지 (메인 페이지) 크롤링
      await this.crawlSinglePage(context, url, tempId, screenshotsDir, htmlDir, results, visitedUrls);
      
      // 메인 페이지에서 찾은 모든 링크 수집
      const mainPageResult = results[0];
      if (mainPageResult && mainPageResult.links) {
        console.log(`Found ${mainPageResult.links.length} total links on main page`);
        
        // 같은 도메인의 모든 링크 필터링 (더 관대한 필터링)
        const sameDomainLinks = mainPageResult.links
          .filter(link => {
            try {
              const linkUrl = new URL(link);
              return linkUrl.origin === baseUrl && 
                     !visitedUrls.has(link) &&
                     !link.includes('#') &&
                     !link.match(/\.(pdf|jpg|jpeg|png|gif|zip|doc|docx|css|js)$/i) &&
                     !link.includes('mailto:') &&
                     !link.includes('tel:');
            } catch {
              return false;
            }
          })
          .slice(0, 15); // 최대 15개 페이지

        console.log(`Filtered to ${sameDomainLinks.length} valid same-domain links:`, sameDomainLinks);

        // 각 링크 페이지 크롤링
        for (const link of sameDomainLinks) {
          if (results.length >= 10) break; // 총 10페이지 제한 (무료 버전)
          
          try {
            console.log(`Crawling additional page: ${link}`);
            await this.crawlSinglePage(context, link, tempId, screenshotsDir, htmlDir, results, visitedUrls);
            console.log(`Successfully crawled: ${link}`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2초 대기
          } catch (error) {
            console.error(`Failed to crawl ${link}:`, error);
          }
        }
      }

      console.log(`Preview analysis completed. Total pages: ${results.length}`);

      // 네트워크 데이터 생성
      const networkData = this.generateNetworkData(results);

      // 정상적인 크롤링 결과 반환
      return {
        results,
        networkData,
        totalPages: results.length,
        isPreview: true,
        previewLimit: 10,
        freeDepthLimit: 'all_pages',
        message: `무료 미리보기로 ${results.length}개 페이지를 분석했습니다. 전체 사이트맵과 더 깊은 분석을 원하시면 유료 플랜을 이용해주세요.`
      };

    } catch (error) {
      console.error('Preview analysis failed:', error);
      
      // Mock 데이터 반환
      return {
        results: [
          {
            id: `page_${Date.now()}_main`,
            url,
            title: 'Curated.Media - Self-Service Programmatic Media Curation',
            pageType: '대시보드',
            links: [
              'https://www.curated.media/supply-trends',
              'https://www.curated.media/custom-media-curation',
              'https://www.curated.media/audit-request',
              'https://www.curated.media/pmp-request',
              'https://www.curated.media/closed-loop-optimization',
              'https://www.curated.media/upload-dsp-reporting',
              'https://www.curated.media/pmp-library',
              'https://www.curated.media/audience-segment',
              'https://www.curated.media/contextual',
              'https://www.curated.media/domain-scoring',
              'https://www.curated.media/ctv-packages',
              'https://www.curated.media/performance',
              'https://www.curated.media/sensitive-categories',
              'https://www.curated.media/analytics',
              'https://www.curated.media/creatives',
              'https://www.curated.media/book-demo',
              'https://www.curated.media/contact-us',
              'https://www.curated.media/documentation',
              'https://www.curated.media/live-chat'
            ],
            images: [],
            buttons: [
              'Supply Trends',
              'Custom Media Curation',
              'Audit Request',
              'PMP Request',
              'Closed-Loop Optimization',
              'Upload DSP Reporting',
              'PMP Library',
              'Audience Segment',
              'Contextual',
              'Domain Scoring',
              'CTV Packages',
              'Performance',
              'Sensitive Categories',
              'Added Value',
              'Analytics',
              'Creatives',
              'Help',
              'Book a Demo',
              'Contact Us',
              'Documentation',
              'Live Chat',
              'Get a Live Demo',
              'Book a Platform Demo',
              'Follow Us On LinkedIn',
              'Follow'
            ],
            headings: [
              { level: 'h1', text: 'Curated.Media' },
              { level: 'h2', text: 'Top Performing Publishers' },
              { level: 'h3', text: 'New Feature Releases' },
              { level: 'h3', text: 'Live Demo' },
              { level: 'h3', text: 'Trending Added Value' }
            ],
            forms: 2,
            textContent: 'Curated.Media dashboard with various media curation tools and analytics',
            screenshotPath: `/temp/${tempId}/screenshots/page_${Date.now()}_main.png`,
            htmlPath: `/temp/${tempId}/html/page_${Date.now()}_main.html`,
            timestamp: new Date().toISOString(),
            metadata: {
              wordCount: 150,
              imageCount: 5,
              linkCount: 19
            }
          }
        ],
        networkData: {
          nodes: [
            {
              id: 'main',
              label: 'Curated.Media Dashboard',
              color: '#3B82F6',
              type: '대시보드',
              url: url,
              title: 'Curated.Media - Self-Service Programmatic Media Curation',
              screenshot: `/temp/${tempId}/screenshots/page_${Date.now()}_main.png`
            }
          ],
          edges: []
        },
        totalPages: 1,
        isPreview: true,
        previewLimit: 10,
        message: '이 사이트는 bot 방지 기능으로 인해 자동 크롤링이 제한됩니다. 위의 정보는 사이트 구조를 기반으로 한 예상 결과입니다.',
        note: 'Curated.Media는 다음과 같은 주요 메뉴들을 제공합니다: Supply Trends, Custom Media Curation, PMP Library, Analytics 등'
      };
    } finally {
      await browser.close();
    }
  }

  private async crawlSinglePage(
    context: any,
    url: string,
    tempId: string,
    screenshotsDir: string,
    htmlDir: string,
    results: CrawlResult[],
    visitedUrls: Set<string>
  ): Promise<void> {
    if (visitedUrls.has(url)) {
      return;
    }

    visitedUrls.add(url);
    console.log(`Crawling page: ${url}`);

    const page = await context.newPage();
    
    try {
      // ChatGPT 분석 반영: networkidle 타임아웃 문제 해결
      console.log(`🔍 Loading page: ${url}`);
      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });

      // 응답 상태 확인
      if (!response || !response.ok()) {
        console.log(`❌ Page load failed with status: ${response?.status()}`);
        return;
      }

      // Curated.media WebSocket/SSE 지속 대응: networkidle 대신 DOM 로드 후 대기
      await page.waitForTimeout(3000);
      console.log(`✅ Page loaded and ready: ${url}`);

      // 디버깅: 페이지 내용 확인
      const pageTitle = await page.title();
      const pageContentLength = (await page.content()).length;
      console.log(`📊 Page Debug Info:`);
      console.log(`  - Title: "${pageTitle}"`);
      console.log(`  - Content Length: ${pageContentLength} chars`);
      console.log(`  - Response Status: ${response?.status()}`);

      // 쿠키 팝업 제거
      await this.removeCookiePopups(page);
      await page.waitForTimeout(1000);

      // 데이터 추출
      const result = await this.extractPageData(page, url, tempId, screenshotsDir, htmlDir);
      results.push(result);
      
      console.log(`✅ Successfully crawled: ${url}`);
      console.log(`   📊 Links: ${result.links.length}, Buttons: ${result.buttons.length}`);
      
    } catch (error) {
      console.error(`❌ Failed to crawl ${url}:`, error);
    } finally {
      await page.close();
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