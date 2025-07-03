import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
// p-limit v4 는 ESM-only 패키지라 require 시 { default: [Function] } 형태를 반환합니다.
// default 가 존재하면 그것을, 없으면 자체 모듈을 사용하도록 하여 런타임 TypeError 를 방지합니다.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pLimit: any = (require('p-limit').default ?? require('p-limit'));

export interface CrawlResult {
  id: string;
  url: string;
  title: string;
  pageType: string;
  links: string[];
  images: { src: string; alt: string; isExternal: boolean }[];
  headings: { level: string; text: string }[];
  forms: number;
  buttons: { text: string; type: string }[];
  textContent: string;
  screenshotPath: string;
  htmlPath: string;
  timestamp: string;
  metadata: {
    wordCount: number;
    imageCount: number;
    linkCount: number;
  };
  elements?: {
    menus: { text: string; href: string; type: 'main' | 'sub' | 'footer' }[];
    buttons: { text: string; type: string; action?: string; href?: string }[];
    forms: { name: string; action: string; fields: number }[];
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
    nodeType: 'page' | 'menu' | 'button' | 'form';
    elementType?: string; // 'main-menu', 'sub-menu', 'footer-menu', 'submit-button', etc.
    parentPageId?: string;
    depth?: number;
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

  constructor(
    private prisma: PrismaService,
    private supabaseService: SupabaseService
  ) {}

  async startCrawling(
    userId: number,
    targetUrl: string,
    maxPages: number = 5,
    supabaseUserId?: string,
  ): Promise<string> {
    // 사용자 플랜 확인
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { analyses: true }
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Supabase에서도 유저 프로필 확인
    let supabaseProfile = null;
    if (supabaseUserId) {
      try {
        supabaseProfile = await this.supabaseService.getUserProfile(supabaseUserId);
      } catch (error) {
        this.logger.warn('Supabase profile not found:', error.message);
      }
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

    // 분석 레코드 생성 (Prisma)
    const analysis = await this.prisma.analysis.create({
      data: {
        userId,
        url: targetUrl,
        status: 'running',
      },
    });

    // Supabase에도 분석 데이터 저장
    let supabaseAnalysis: any = null;
    if (supabaseUserId) {
      try {
        supabaseAnalysis = await this.supabaseService.saveAnalysis(supabaseUserId, {
          url: targetUrl,
          status: 'running',
          progress: 0
        });
      } catch (error) {
        this.logger.warn('Failed to save analysis to Supabase:', error.message);
      }
    }

    // 백그라운드에서 크롤링 실행
    this.performOptimizedCrawling(
      analysis.id, 
      targetUrl, 
      maxPages, 
      user.plan,
      supabaseUserId,
      supabaseAnalysis?.id
    ).catch((error) => {
      this.logger.error(`Crawling failed for analysis ${analysis.id}:`, error);
      this.prisma.analysis.update({
        where: { id: analysis.id },
        data: { status: 'failed' },
      });
      
      // Supabase 분석도 실패로 업데이트
      if (supabaseUserId && supabaseAnalysis?.id) {
        this.supabaseService.updateAnalysis(supabaseAnalysis.id, {
          status: 'failed'
        }).catch(err => this.logger.warn('Failed to update Supabase analysis status:', err.message));
      }
    });

    return analysis.id;
  }

  private async performOptimizedCrawling(
    analysisId: string,
    startUrl: string,
    maxPages: number,
    userPlan: string,
    supabaseUserId?: string,
    supabaseAnalysisId?: string,
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

      // Update analysis (Prisma)
      await this.prisma.analysis.update({
        where: { id: analysisId },
        data: {
          status: 'completed',
          pageCount: results.length,
          progress: 100,
          title: results[0]?.title || 'Website Analysis'
        },
      });

      // Update Supabase analysis
      if (supabaseUserId && supabaseAnalysisId) {
        try {
          await this.supabaseService.updateAnalysis(supabaseAnalysisId, {
            status: 'completed',
            page_count: results.length,
            progress: 100,
            title: results[0]?.title || 'Website Analysis',
            resultData: {
              results,
              networkData,
              totalPages: results.length,
              isPreview: false,
              message: `Successfully crawled ${results.length} pages`
            },
            html_path: htmlPath
          });
    } catch (error) {
          this.logger.warn('Failed to update Supabase analysis:', error.message);
        }
      }

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
    this.logger.log(`Starting URL discovery for: ${startUrl}`);
    
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

        this.logger.log(`Processing URL: ${currentUrl}`);

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

          this.logger.log(`Found ${links.length} links on ${currentUrl}`);

          // Add discovered links
          for (const link of links) {
            if (!discoveredUrls.has(link) && discoveredUrls.size < maxUrls) {
              discoveredUrls.add(link);
              urlQueue.push(link);
            }
          }

      } catch (error) {
          this.logger.warn(`Failed to discover URLs from ${currentUrl}: ${error.message}`);
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
    this.logger.log(`Starting parallel crawl for ${urls.length} URLs`);
    
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

    this.logger.log(`Parallel crawl completed. Got ${results.filter(r => r !== null).length} results`);
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

    try {
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
        page.evaluate((baseUrl) => {
          try {
            // 메뉴 수집 함수 - 네비게이션 메뉴를 정확히 식별
            const collectMenus = () => {
              const menus: { text: string; href: string; type: 'main' | 'sub' | 'footer' }[] = [];
              
              // 메인 네비게이션 메뉴
              const mainNavSelectors = [
                'nav a', 'header a', '[role="navigation"] a',
                '.nav a', '.navbar a', '.menu a', '.navigation a',
                '[class*="nav-"] a', '[class*="menu-"] a'
              ];
              
              mainNavSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => {
                  const link = el as HTMLAnchorElement;
                  const text = link.textContent?.trim() || '';
                  const href = link.href || '';
                  
                  if (text && href && !href.includes('#') && text.length > 1) {
                    // 중복 제거
                    const exists = menus.some(m => m.text === text && m.href === href);
                    if (!exists) {
                      menus.push({ text, href, type: 'main' });
                    }
                  }
                });
              });
              
              // 푸터 메뉴
              const footerSelectors = ['footer a', '.footer a', '[class*="footer"] a'];
              footerSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => {
                  const link = el as HTMLAnchorElement;
                  const text = link.textContent?.trim() || '';
                  const href = link.href || '';
                  
                  if (text && href && !href.includes('#') && text.length > 1) {
                    const exists = menus.some(m => m.text === text && m.href === href);
                    if (!exists) {
                      menus.push({ text, href, type: 'footer' });
                    }
                  }
                });
              });
              
              return menus;
            };

            // 버튼 수집 함수 - 실제 버튼 텍스트와 기능 식별
            const collectButtons = () => {
              const buttons: { text: string; type: string; action?: string; href?: string }[] = [];
              
              // 버튼 요소들
              const buttonElements = document.querySelectorAll(
                'button, input[type="button"], input[type="submit"], [role="button"], a.btn, a.button'
              );
              
              buttonElements.forEach(el => {
                let text = '';
                let type = 'button';
                let action = '';
                let href = '';
                
                if (el.tagName === 'BUTTON') {
                  text = el.textContent?.trim() || '';
                  type = (el as HTMLButtonElement).type || 'button';
                } else if (el.tagName === 'INPUT') {
                  const input = el as HTMLInputElement;
                  text = input.value || input.placeholder || '';
                  type = input.type;
                } else if (el.tagName === 'A') {
                  const link = el as HTMLAnchorElement;
                  text = link.textContent?.trim() || '';
                  href = link.href || '';
                  type = 'link-button';
                } else {
                  text = el.textContent?.trim() || el.getAttribute('aria-label') || '';
                }
                
                // onclick 속성에서 action 추출
                const onclick = el.getAttribute('onclick');
                if (onclick) {
                  action = onclick.substring(0, 50);
                }
                
                // 노이즈 필터링
                if (text && text.length > 0 && text.length < 50 && 
                    !text.match(/^[\s\n]*$/) && 
                    !text.toLowerCase().includes('cookie')) {
                  buttons.push({ text, type, action, href });
                }
              });
              
              return buttons;
            };

            // 폼 수집 함수
            const collectForms = () => {
              const forms: { name: string; action: string; fields: number }[] = [];
              
              document.querySelectorAll('form').forEach(form => {
                const name = form.getAttribute('name') || 
                            form.getAttribute('id') || 
                            form.querySelector('h1, h2, h3, h4')?.textContent?.trim() ||
                            '폼';
                const action = form.action || '';
                const fields = form.querySelectorAll('input, textarea, select').length;
                
                forms.push({ name, action, fields });
              });
              
              return forms;
            };

            // SPA(Next.js, Nuxt, Vue 등)에서 동적으로 생성되는 라우트를 포함해 내부 링크를 수집합니다.
            const collectLinks = () => {
              const urlSet = new Set<string>();

              // 1) 일반 <a> 태그
              document.querySelectorAll('a[href]').forEach((a) => {
                try {
                  const href = (a as HTMLAnchorElement).href;
                  const abs = new URL(href, location.href);
                  if (abs.protocol.startsWith('http')) {
                    urlSet.add(abs.toString());
                  }
                } catch {}
              });

              // 2) Vue / Nuxt router-link, nuxt-link
              document.querySelectorAll('router-link[to], nuxt-link[to]').forEach((el) => {
                const to = (el as HTMLElement).getAttribute('to');
                if (to) {
                  try {
                    urlSet.add(new URL(to, location.origin).toString());
                  } catch {}
                }
              });

              // 3) Next.js 전역 데이터(__NEXT_DATA__)
              try {
                const nextData: any = (window as any).__NEXT_DATA__;
                if (nextData) {
                  if (typeof nextData.page === 'string') {
                    urlSet.add(new URL(nextData.page, location.origin).toString());
                  }
                  const buildPages = nextData.__BUILD_MANIFEST?.sortedPages || [];
                  (buildPages as string[]).forEach((p) => {
                    if (p) {
                      urlSet.add(new URL(p, location.origin).toString());
                    }
                  });
                }
              } catch {}

              // 4) Nuxt.js 전역 데이터(__NUXT__)
              try {
                const nuxtData: any = (window as any).__NUXT__;
                if (nuxtData && Array.isArray(nuxtData.routes)) {
                  (nuxtData.routes as string[]).forEach((r) => {
                    if (r) {
                      urlSet.add(new URL(r, location.origin).toString());
                    }
                  });
                }
              } catch {}

              // 5) 클릭 가능한 요소들에서 data-href, data-url 등 추출
              document.querySelectorAll('[data-href], [data-url], [data-link]').forEach((el) => {
                const dataHref = (el as HTMLElement).getAttribute('data-href') || 
                                (el as HTMLElement).getAttribute('data-url') || 
                                (el as HTMLElement).getAttribute('data-link');
                if (dataHref) {
                  try {
                    urlSet.add(new URL(dataHref, location.origin).toString());
                  } catch {}
                }
              });

              // 실제 존재하는 링크만 반환 (추측 제거)
              return Array.from(urlSet);
            };

            const links = collectLinks();
            const menus = collectMenus();
            const buttons = collectButtons();
            const forms = collectForms();

            // 상세 메타데이터 추출
            const title = document.title || '';
            const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
              .map(h => ({
                level: h.tagName.toLowerCase(),
                text: h.textContent?.trim() || ''
              }))
              .filter(h => h.text.length > 0)
              .slice(0, 5);

            // 이미지 정보 수집 (src, alt 포함)
            const images = Array.from(document.querySelectorAll('img'))
              .map(img => {
                const imgEl = img as HTMLImageElement;
                const srcAttr = imgEl.getAttribute('src') || imgEl.getAttribute('data-src');
                const src = srcAttr || imgEl.src || '';
                const alt = imgEl.alt || '';
                const isExternal = src.startsWith('http') && !src.includes(location.hostname);
                return { src, alt, isExternal };
              })
              .filter(img => img.src && img.src !== '' && !img.src.includes('data:'))
              .slice(0, 20);

            // CSS background-image에서 이미지 추출
            const bgImages = Array.from(document.querySelectorAll('*'))
              .map(el => {
                const style = window.getComputedStyle(el);
                const bgImage = style.backgroundImage;
                if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
                  const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
                  if (match && match[1]) {
                    return { src: match[1], alt: 'Background Image', isExternal: false };
                  }
                }
                return null;
              })
              .filter(Boolean)
              .slice(0, 5);

            const allImages = [...images, ...bgImages];

            const textContent = document.body.textContent?.trim().substring(0, 300) || '';
            const wordCount = textContent.split(/\s+/).length;

      return {
              title,
              links: links.slice(0, 30), // 링크 수 제한 확대 (SPA 지원)
              headings,
              menus,
              buttons,
              forms,
              images: allImages as { src: string; alt: string; isExternal: boolean }[],
              textContent,
              wordCount
            };
          } catch (error) {
            console.error('Error in page evaluation:', error);
            return {
              title: document.title || '',
              links: [],
              images: [],
              headings: [],
              forms: 0,
              buttons: [],
              textContent: '',
              wordCount: 0
            };
          }
        }, url),
        cookiePromise
      ]);

      this.logger.log(`Extracted data from ${url}: ${pageData.links.length} links, ${pageData.images.length} images`);

      // Take screenshot (full page)
      const screenshotFilename = `${pageId}.png`;
      // Ensure sub-directories exist (screenshots / html)
      await fs.promises.mkdir(path.join(outputDir, 'screenshots'), { recursive: true });
      await fs.promises.mkdir(path.join(outputDir, 'html'), { recursive: true });

      const screenshotPathOnDisk = path.join(outputDir, 'screenshots', screenshotFilename);
      const screenshotPath = `/temp/${path.basename(outputDir)}/screenshots/${screenshotFilename}`;
      
      // Capture full page screenshot with scrolling
      await page.screenshot({
        path: screenshotPathOnDisk,
        fullPage: true, // Capture entire page including scrolled content
        type: 'png'
      });

      // Save HTML (optional - can skip for speed)
      const htmlFilename = `${pageId}.html`;
      const htmlPathOnDisk = path.join(outputDir, 'html', htmlFilename);
      const htmlContent = await page.content();
      await fs.promises.writeFile(htmlPathOnDisk, htmlContent);

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

      const refinedTitle = this.refineTitle(url, pageData.title);
      const btnObjs = pageData.buttons.map((b: any) => typeof b === 'string' ? { text: b, type: 'button' } : b);
      const cleanButtons = this.filterButtons(btnObjs);

      return {
      id: pageId,
      url,
      title: refinedTitle,
      pageType,
      links: pageData.links,
      images: pageData.images,
      headings: pageData.headings,
      forms: Array.isArray(pageData.forms) ? pageData.forms.length : typeof pageData.forms === 'number' ? pageData.forms : 0,
        buttons: cleanButtons,
      textContent: pageData.textContent,
        screenshotPath,
        htmlPath: `/temp/${path.basename(outputDir)}/html/${htmlFilename}`,
      timestamp,
      metadata: {
          wordCount: pageData.wordCount,
        imageCount: pageData.images.length,
        linkCount: pageData.links.length
      }
    };
    } catch (error) {
      this.logger.error(`Failed to crawl page ${url}:`, error);
      throw error;
    }
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

  private refineTitle(pageUrl: string, rawTitle: string): string {
    const cleaned = (rawTitle || '').trim();
    const lower = cleaned.toLowerCase();
    if (!cleaned || lower === 'home' || lower === 'index' || lower === 'homepage') {
      const pathname = new URL(pageUrl).pathname.replace(/\/$/, '');
      if (!pathname || pathname === '' || pathname === '/') return 'Home';
      const slug = pathname.split('/').filter(Boolean).pop() || 'Page';
      return slug
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return cleaned;
  }

  // 노이즈 버튼(캐러셀·화살표 등) 제거 + 중복 제거
  private filterButtons(buttons: { text: string; type: string }[]): { text: string; type: string }[] {
    const noiseRegex = /(carousel|arrow|switch|index|닫기|열기|prev|next|menu)/i;
    const uniq: { [key: string]: boolean } = {};
    return buttons
      .filter((b) => b.text && b.text.length >= 2 && !noiseRegex.test(b.text))
      .filter((b) => {
        if (uniq[b.text]) return false;
        uniq[b.text] = true;
        return true;
      })
      .slice(0, 8); // 페이지당 최대 8개 유지
  }

  // 무료 미리보기 - 더 빠르게!
  async getPreviewAnalysis(url: string): Promise<AnalysisResult> {
    this.logger.log(`=== getPreviewAnalysis START (링크 구조만 빠르게 탐색) ===`);
    this.logger.log(`Starting fast structure discovery for: ${url}`);

    // URL 검증 및 기본 도메인 추출
    let baseUrl: URL;
    try {
      baseUrl = new URL(url);
    } catch {
      throw new BadRequestException('유효하지 않은 URL입니다.');
    }
    
    const baseDomain = baseUrl.hostname;
    this.logger.log(`URL validation passed: ${url}`);
    this.logger.log(`Base domain for filtering: ${baseDomain}`);

    const browser = await chromium.launch({ headless: true });
    
    try {
      // ====== 빠른 링크 구조 탐색 (스크린샷/HTML 없이) ======
      const MAX_DEPTH = 3;
      const CONCURRENCY = 5; // 더 빠르게
      const MAX_LINKS_PER_PAGE = 15; // 페이지당 링크 수 제한

      const visited = new Set<string>();
      const queue: { url: string; depth: number; parentId?: string }[] = [{ url, depth: 1 }];
      const allResults: CrawlResult[] = [];

      const limit = pLimit(CONCURRENCY);

      // 동일한 도메인 링크만 필터링하는 함수
      const filterSameDomainLinks = (links: string[]): string[] => {
        return links.filter(link => {
          try {
            const linkUrl = new URL(link);
            return linkUrl.hostname === baseDomain;
          } catch {
            return false;
          }
        });
      };

      const processPage = async (pageUrl: string, depth: number, parentId?: string) => {
        if (visited.has(pageUrl)) return;
        visited.add(pageUrl);

    const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (compatible; WebCrawler/1.0)',
          viewport: { width: 1280, height: 800 }
        });
        const page = await context.newPage();

        try {
          this.logger.log(`🔍 Discovering structure (${allResults.length + 1}): ${pageUrl} (depth: ${depth})`);
          
          await page.goto(pageUrl, {
            waitUntil: 'load',
            timeout: 15000
          });

          // SPA 페이지의 JS 렌더링이 완료되도록 추가 대기
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(1500);

          // SPA 특화: 메뉴 버튼 클릭 시뮬레이션으로 추가 링크 노출
          await page.evaluate(() => {
            // 햄버거 메뉴, 네비게이션 버튼 등을 클릭해서 숨겨진 링크 노출
            const menuSelectors = [
              'button[aria-label*="menu"]',
              'button[class*="menu"]',
              'button[class*="nav"]',
              '.menu-toggle',
              '.nav-toggle',
              '[data-toggle="menu"]',
              '[role="button"][aria-expanded="false"]'
            ];
            
            menuSelectors.forEach(selector => {
              const elements = document.querySelectorAll(selector);
              elements.forEach(el => {
                try {
                  (el as HTMLElement).click();
                } catch {}
              });
            });
          }).catch(() => {});

          // 메뉴 클릭 후 DOM 업데이트 대기
          await page.waitForTimeout(1000);

          // 빠른 데이터 추출 (스크린샷/HTML 없이)
          const pageData = await page.evaluate(() => {
          // 쿠키 팝업 제거
            const cookieSelectors = [
              '[class*="cookie"]', '[id*="cookie"]',
              '[class*="consent"]', '[id*="consent"]',
              '[class*="gdpr"]', '[id*="gdpr"]'
            ];
            
            cookieSelectors.forEach(selector => {
              const elements = document.querySelectorAll(selector);
              elements.forEach(el => {
                if (el.textContent?.toLowerCase().includes('cookie') || 
                    el.textContent?.toLowerCase().includes('consent')) {
                  (el as HTMLElement).style.display = 'none';
                }
              });
            });

            // 메뉴 수집 함수 - 네비게이션 메뉴를 정확히 식별
            const collectMenus = () => {
              const menus: { text: string; href: string; type: 'main' | 'sub' | 'footer' }[] = [];
              
              // 메인 네비게이션 메뉴
              const mainNavSelectors = [
                'nav a', 'header a', '[role="navigation"] a',
                '.nav a', '.navbar a', '.menu a', '.navigation a',
                '[class*="nav-"] a', '[class*="menu-"] a'
              ];
              
              mainNavSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => {
                  const link = el as HTMLAnchorElement;
                  const text = link.textContent?.trim() || '';
                  const href = link.href || '';
                  
                  if (text && href && !href.includes('#') && text.length > 1) {
                    // 중복 제거
                    const exists = menus.some(m => m.text === text && m.href === href);
                    if (!exists) {
                      menus.push({ text, href, type: 'main' });
                    }
                  }
                });
              });
              
              // 푸터 메뉴
              const footerSelectors = ['footer a', '.footer a', '[class*="footer"] a'];
              footerSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => {
                  const link = el as HTMLAnchorElement;
                  const text = link.textContent?.trim() || '';
                  const href = link.href || '';
                  
                  if (text && href && !href.includes('#') && text.length > 1) {
                    const exists = menus.some(m => m.text === text && m.href === href);
                    if (!exists) {
                      menus.push({ text, href, type: 'footer' });
                    }
                  }
                });
              });
              
              return menus;
            };

            // 버튼 수집 함수 - 실제 버튼 텍스트와 기능 식별
            const collectButtons = () => {
              const buttons: { text: string; type: string; action?: string; href?: string }[] = [];
              
              // 버튼 요소들
              const buttonElements = document.querySelectorAll(
                'button, input[type="button"], input[type="submit"], [role="button"], a.btn, a.button'
              );
              
              buttonElements.forEach(el => {
                let text = '';
                let type = 'button';
                let action = '';
                let href = '';
                
                if (el.tagName === 'BUTTON') {
                  text = el.textContent?.trim() || '';
                  type = (el as HTMLButtonElement).type || 'button';
                } else if (el.tagName === 'INPUT') {
                  const input = el as HTMLInputElement;
                  text = input.value || input.placeholder || '';
                  type = input.type;
                } else if (el.tagName === 'A') {
                  const link = el as HTMLAnchorElement;
                  text = link.textContent?.trim() || '';
                  href = link.href || '';
                  type = 'link-button';
                } else {
                  text = el.textContent?.trim() || el.getAttribute('aria-label') || '';
                }
                
                // onclick 속성에서 action 추출
                const onclick = el.getAttribute('onclick');
                if (onclick) {
                  action = onclick.substring(0, 50);
                }
                
                // 노이즈 필터링
                if (text && text.length > 0 && text.length < 50 && 
                    !text.match(/^[\s\n]*$/) && 
                    !text.toLowerCase().includes('cookie')) {
                  buttons.push({ text, type, action, href });
                }
              });
              
              return buttons;
            };

            // 폼 수집 함수
            const collectForms = () => {
              const forms: { name: string; action: string; fields: number }[] = [];
              
              document.querySelectorAll('form').forEach(form => {
                const name = form.getAttribute('name') || 
                            form.getAttribute('id') || 
                            form.querySelector('h1, h2, h3, h4')?.textContent?.trim() ||
                            '폼';
                const action = form.action || '';
                const fields = form.querySelectorAll('input, textarea, select').length;
                
                forms.push({ name, action, fields });
              });
              
              return forms;
            };

            // SPA(Next.js, Nuxt, Vue 등)에서 동적으로 생성되는 라우트를 포함해 내부 링크를 수집합니다.
            const collectLinks = () => {
              const urlSet = new Set<string>();

              // 1) 일반 <a> 태그
              document.querySelectorAll('a[href]').forEach((a) => {
                try {
                  const href = (a as HTMLAnchorElement).href;
                  const abs = new URL(href, location.href);
                  if (abs.protocol.startsWith('http')) {
                    urlSet.add(abs.toString());
                  }
                } catch {}
              });

              // 2) Vue / Nuxt router-link, nuxt-link
              document.querySelectorAll('router-link[to], nuxt-link[to]').forEach((el) => {
                const to = (el as HTMLElement).getAttribute('to');
                if (to) {
                  try {
                    urlSet.add(new URL(to, location.origin).toString());
                  } catch {}
                }
              });

              // 3) Next.js 전역 데이터(__NEXT_DATA__)
              try {
                const nextData: any = (window as any).__NEXT_DATA__;
                if (nextData) {
                  if (typeof nextData.page === 'string') {
                    urlSet.add(new URL(nextData.page, location.origin).toString());
                  }
                  const buildPages = nextData.__BUILD_MANIFEST?.sortedPages || [];
                  (buildPages as string[]).forEach((p) => {
                    if (p) {
                      urlSet.add(new URL(p, location.origin).toString());
                    }
                  });
                }
              } catch {}

              // 4) Nuxt.js 전역 데이터(__NUXT__)
              try {
                const nuxtData: any = (window as any).__NUXT__;
                if (nuxtData && Array.isArray(nuxtData.routes)) {
                  (nuxtData.routes as string[]).forEach((r) => {
                    if (r) {
                      urlSet.add(new URL(r, location.origin).toString());
                    }
                  });
                }
              } catch {}

              // 5) 클릭 가능한 요소들에서 data-href, data-url 등 추출
              document.querySelectorAll('[data-href], [data-url], [data-link]').forEach((el) => {
                const dataHref = (el as HTMLElement).getAttribute('data-href') || 
                                (el as HTMLElement).getAttribute('data-url') || 
                                (el as HTMLElement).getAttribute('data-link');
                if (dataHref) {
                  try {
                    urlSet.add(new URL(dataHref, location.origin).toString());
                  } catch {}
                }
              });

              // 실제 존재하는 링크만 반환 (추측 제거)
              return Array.from(urlSet);
            };

            const links = collectLinks();
            const menus = collectMenus();
            const buttons = collectButtons();
            const forms = collectForms();

            // 상세 메타데이터 추출
            const title = document.title || '';
            const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
              .map(h => ({
                level: h.tagName.toLowerCase(),
                text: h.textContent?.trim() || ''
              }))
              .filter(h => h.text.length > 0)
              .slice(0, 5);

            // 이미지 정보 수집 (src, alt 포함)
            const images = Array.from(document.querySelectorAll('img'))
              .map(img => {
                const imgEl = img as HTMLImageElement;
                const srcAttr = imgEl.getAttribute('src') || imgEl.getAttribute('data-src');
                const src = srcAttr || imgEl.src || '';
                const alt = imgEl.alt || '';
                const isExternal = src.startsWith('http') && !src.includes(location.hostname);
                return { src, alt, isExternal };
              })
              .filter(img => img.src && img.src !== '' && !img.src.includes('data:'))
              .slice(0, 20);

            // CSS background-image에서 이미지 추출
            const bgImages = Array.from(document.querySelectorAll('*'))
              .map(el => {
                const style = window.getComputedStyle(el);
                const bgImage = style.backgroundImage;
                if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
                  const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
                  if (match && match[1]) {
                    return { src: match[1], alt: 'Background Image', isExternal: false };
                  }
                }
                return null;
              })
              .filter(Boolean)
              .slice(0, 5);

            const allImages = [...images, ...bgImages];

            const textContent = document.body.textContent?.trim().substring(0, 300) || '';
            const wordCount = textContent.split(/\s+/).length;

      return {
              title,
              links: links.slice(0, 30), // 링크 수 제한 확대 (SPA 지원)
              headings,
              menus,
              buttons,
              forms,
              images: allImages as { src: string; alt: string; isExternal: boolean }[],
              textContent,
              wordCount
            };
          });

          // 동일한 도메인 링크만 필터링
          const filteredLinks = filterSameDomainLinks(pageData.links);
          
          // 결과 객체 생성 (스크린샷/HTML 경로는 빈 문자열)
          const refinedTitle = this.refineTitle(pageUrl, pageData.title);
          const btnObjs2 = pageData.buttons.map((b: any) => typeof b === 'string' ? { text: b, type: 'button' } : b);
          const cleanButtons = this.filterButtons(btnObjs2);

          const result: CrawlResult = {
            id: `preview_${Date.now()}_${allResults.length}_depth${depth}`,
            url: pageUrl,
            title: refinedTitle,
            pageType: this.classifyPageType(pageUrl, refinedTitle),
            links: filteredLinks,
            images: pageData.images,
            headings: pageData.headings,
            forms: Array.isArray(pageData.forms) ? pageData.forms.length : typeof pageData.forms === 'number' ? pageData.forms : 0,
            buttons: cleanButtons,
            textContent: pageData.textContent,
            screenshotPath: '', // 나중에 요청시 생성
            htmlPath: '', // 나중에 요청시 생성
            timestamp: new Date().toISOString(),
            metadata: {
              wordCount: pageData.wordCount,
              imageCount: pageData.images.length,
              linkCount: filteredLinks.length
            },
            // 구조화된 요소 정보 추가
            elements: {
              menus: pageData.menus || [],
              buttons: pageData.buttons || [],
              forms: pageData.forms || []
            }
          };

          allResults.push(result);

          // 다음 레벨 큐에 추가 (동일한 도메인 링크만)
          if (depth < MAX_DEPTH) {
            filteredLinks
              .filter(link => !visited.has(link))
              .slice(0, MAX_LINKS_PER_PAGE)
              .forEach(link => {
                queue.push({ url: link, depth: depth + 1, parentId: result.id });
              });
          }

        } catch (err) {
          this.logger.warn(`Failed to discover structure for ${pageUrl}: ${err?.message}`);
        } finally {
          await page.close();
          await context.close();
        }
      };

      // BFS 방식으로 구조 탐색
      while (queue.length > 0) {
        const currentBatch = queue.splice(0, Math.min(queue.length, 8)); // 배치 크기 제한
        await Promise.allSettled(
          currentBatch.map(({ url: pageUrl, depth, parentId }) => 
            limit(() => processPage(pageUrl, depth, parentId))
          )
        );
      }

      await browser.close();

      // 네트워크 데이터 생성
      const networkData = this.generateNetworkData(allResults, {});

      this.logger.log(`✅ Structure discovery completed! (총 ${allResults.length} 페이지)`);
      this.logger.log(`=== getPreviewAnalysis END ===`);
      
      return {
        results: allResults,
        networkData,
        totalPages: allResults.length,
        isPreview: true,
        previewLimit: allResults.length,
        message: `사이트 구조를 빠르게 분석했습니다. (${allResults.length}개 페이지 발견)`
      };

    } catch (error) {
      this.logger.error(`❌ Error during structure discovery:`, error);
      await browser.close();
      throw error;
    }
  }

  // 페이지 타입 분류 헬퍼 메서드
  private classifyPageType(url: string, title: string): string {
    const urlLower = url.toLowerCase();
    const titleLower = title.toLowerCase();

    // URL 경로 분석
    const pathname = new URL(url).pathname.toLowerCase();
    
    // 홈페이지
    if (pathname === '/' || pathname === '/index' || pathname === '/home') return '홈페이지';
    
    // 인증 관련
    if (pathname.includes('/login') || pathname.includes('/signin')) return '로그인';
    if (pathname.includes('/signup') || pathname.includes('/register')) return '회원가입';
    if (pathname.includes('/logout') || pathname.includes('/signout')) return '로그아웃';
    
    // 정보 페이지
    if (pathname.includes('/about') || titleLower.includes('about')) return '소개페이지';
    if (pathname.includes('/contact') || titleLower.includes('contact')) return '연락처';
    if (pathname.includes('/company') || titleLower.includes('company')) return '회사정보';
    if (pathname.includes('/team') || titleLower.includes('team')) return '팀소개';
    
    // 제품/서비스
    if (pathname.includes('/product') || titleLower.includes('product')) return '제품페이지';
    if (pathname.includes('/service') || titleLower.includes('service')) return '서비스페이지';
    if (pathname.includes('/solution') || titleLower.includes('solution')) return '솔루션';
    if (pathname.includes('/pricing') || titleLower.includes('pricing')) return '가격정책';
    if (pathname.includes('/plans') || titleLower.includes('plan')) return '요금제';
    if (pathname.includes('/features') || titleLower.includes('feature')) return '기능소개';
    
    // 콘텐츠
    if (pathname.includes('/blog') || titleLower.includes('blog')) return '블로그';
    if (pathname.includes('/news') || titleLower.includes('news')) return '뉴스';
    if (pathname.includes('/article') || titleLower.includes('article')) return '기사';
    if (pathname.includes('/resource') || titleLower.includes('resource')) return '자료실';
    if (pathname.includes('/documentation') || pathname.includes('/docs')) return '문서';
    
    // 지원
    if (pathname.includes('/support') || titleLower.includes('support')) return '고객지원';
    if (pathname.includes('/help') || titleLower.includes('help')) return '도움말';
    if (pathname.includes('/faq') || titleLower.includes('faq')) return 'FAQ';
    
    // 채용
    if (pathname.includes('/career') || pathname.includes('/jobs')) return '채용정보';
    
    // 법률/정책
    if (pathname.includes('/privacy') || titleLower.includes('privacy')) return '개인정보처리방침';
    if (pathname.includes('/terms') || titleLower.includes('terms')) return '이용약관';
    if (pathname.includes('/legal') || titleLower.includes('legal')) return '법적고지';
    
    return '일반페이지';
  }

  // 개별 페이지의 스크린샷과 HTML을 요청시 생성하는 새로운 메서드
  async getPageDetails(url: string): Promise<{ screenshotPath: string; htmlPath: string; title: string }> {
    this.logger.log(`Getting page details for: ${url}`);

    const browser = await chromium.launch({ headless: true });
    
    try {
      const outputDir = path.join(process.cwd(), 'temp', `details_${Date.now()}`);
      await fs.promises.mkdir(path.join(outputDir, 'screenshots'), { recursive: true });
      await fs.promises.mkdir(path.join(outputDir, 'html'), { recursive: true });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (compatible; WebCrawler/1.0)',
        viewport: { width: 1280, height: 800 }
      });
      
      const page = await context.newPage();

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      
      // 쿠키 팝업 제거
      await this.quickRemoveCookies(page);

      // 스크린샷 생성 (전체 페이지)
      const screenshotFilename = `page_${Date.now()}.png`;
      const screenshotPathOnDisk = path.join(outputDir, 'screenshots', screenshotFilename);
      await page.screenshot({
        path: screenshotPathOnDisk,
        fullPage: true // 전체 페이지 캡처 (스크롤 포함)
      });

      // HTML 저장
      const htmlFilename = `page_${Date.now()}.html`;
      const htmlPathOnDisk = path.join(outputDir, 'html', htmlFilename);
      const htmlContent = await page.content();
      await fs.promises.writeFile(htmlPathOnDisk, htmlContent);

      const title = await page.title();

      await context.close();
      await browser.close();

      return {
        screenshotPath: `/temp/${path.basename(outputDir)}/screenshots/${screenshotFilename}`,
        htmlPath: `/temp/${path.basename(outputDir)}/html/${htmlFilename}`,
        title
      };

    } catch (error) {
      this.logger.error(`Error getting page details for ${url}:`, error);
      await browser.close();
      throw error;
    }
  }

  // 페이지와 버튼을 구분하는 네트워크 데이터 생성
  private generateNetworkData(results: CrawlResult[], sitemap: Record<string, string[]>): NetworkData {
    const nodes: NetworkNode[] = [];
    const edges: NetworkEdge[] = [];
    const processedUrls = new Set<string>();
    
    // 색상 정의
    const pageColors = {
      '홈페이지': '#ef4444',         // 빨강
      '소개페이지': '#10b981',       // 초록
      '회사정보': '#10b981',         // 초록
      '팀소개': '#10b981',           // 초록
      '연락처': '#f59e0b',           // 주황
      '제품페이지': '#8b5cf6',       // 보라
      '서비스페이지': '#06b6d4',     // 하늘색
      '솔루션': '#06b6d4',           // 하늘색
      '가격정책': '#ec4899',         // 핑크
      '요금제': '#ec4899',           // 핑크
      '기능소개': '#8b5cf6',         // 보라
      '블로그': '#f97316',           // 오렌지
      '뉴스': '#f97316',             // 오렌지
      '자료실': '#f97316',           // 오렌지
      '문서': '#6366f1',             // 인디고
      '고객지원': '#14b8a6',         // 청록
      '도움말': '#14b8a6',           // 청록
      'FAQ': '#14b8a6',              // 청록
      '로그인': '#64748b',           // 회색
      '회원가입': '#64748b',         // 회색
      '채용정보': '#84cc16',         // 라임
      '개인정보처리방침': '#94a3b8', // 연회색
      '이용약관': '#94a3b8',         // 연회색
      '법적고지': '#94a3b8',         // 연회색
      '일반페이지': '#6b7280'        // 회색
    };
    
    const elementColors = {
      'main-menu': '#3b82f6',        // 파랑 - 메인 메뉴
      'sub-menu': '#60a5fa',         // 연파랑 - 서브 메뉴
      'footer-menu': '#93c5fd',      // 밝은 파랑 - 푸터 메뉴
      'button': '#a855f7',           // 보라 - 일반 버튼
      'submit': '#7c3aed',           // 진한 보라 - 제출 버튼
      'link-button': '#c084fc',      // 연보라 - 링크 버튼
      'form': '#fbbf24'              // 노랑 - 폼
    };
    
    // Depth별로 결과 그룹화
    const resultsByDepth: { [depth: number]: CrawlResult[] } = {};
    results.forEach(result => {
      const depthMatch = result.id.match(/depth(\d+)/);
      const depth = depthMatch ? parseInt(depthMatch[1]) : 0;
      if (!resultsByDepth[depth]) resultsByDepth[depth] = [];
      resultsByDepth[depth].push(result);
    });
    
    results.forEach((result) => {
      if (!processedUrls.has(result.url)) {
        processedUrls.add(result.url);
        
        const depthMatch = result.id.match(/depth(\d+)/);
        const depth = depthMatch ? parseInt(depthMatch[1]) : 0;
        
        // 페이지 색상 선택
        const pageColor = pageColors[result.pageType] || pageColors['일반페이지'];
        
        // 페이지 노드 추가
        nodes.push({
          id: result.id,
          label: result.title.substring(0, 40) + (result.title.length > 40 ? '...' : ''),
          color: pageColor,
          type: result.pageType,
          url: result.url,
          title: result.title,
          screenshot: result.screenshotPath,
          nodeType: 'page' as const,
          depth
        });

        // 메뉴 노드 추가
        if (result.elements?.menus && result.elements.menus.length > 0) {
          result.elements.menus.forEach((menu, index) => {
            const menuId = `${result.id}_menu_${index}`;
            const menuColor = menu.type === 'main' ? elementColors['main-menu'] :
                            menu.type === 'footer' ? elementColors['footer-menu'] :
                            elementColors['sub-menu'];
            
            nodes.push({
              id: menuId,
              label: menu.text,
              color: menuColor,
              type: `${menu.type}-menu`,
              url: menu.href,
              title: `${menu.text} (${result.title})`,
              screenshot: '',
              nodeType: 'menu' as const,
              elementType: `${menu.type}-menu`,
              parentPageId: result.id,
              depth
            });

            // 페이지에서 메뉴로의 연결선
            edges.push({
              from: result.id,
              to: menuId
            });
            
            // 메뉴가 가리키는 페이지로의 연결선
            const targetPage = results.find(r => r.url === menu.href);
            if (targetPage) {
              edges.push({
                from: menuId,
                to: targetPage.id
              });
            }
          });
        }

        // 버튼 노드 추가 (중요한 버튼만)
        if (result.elements?.buttons && result.elements.buttons.length > 0) {
          // 중요한 버튼만 필터링
          const importantButtons = result.elements.buttons.filter(btn => {
            const text = btn.text.toLowerCase();
            return !text.includes('cookie') && 
                   !text.includes('accept') && 
                   !text.includes('decline') &&
                   !text.includes('×') &&
                   !text.includes('x') &&
                   text.length > 2 &&
                   text.length < 30;
          }).slice(0, 5); // 최대 5개만
          
          importantButtons.forEach((button, index) => {
            const buttonId = `${result.id}_button_${index}`;
            const buttonColor = button.type === 'submit' ? elementColors['submit'] :
                              button.type === 'link-button' ? elementColors['link-button'] :
                              elementColors['button'];
            
            nodes.push({
              id: buttonId,
              label: button.text,
              color: buttonColor,
              type: button.type,
              url: button.href || result.url,
              title: `${button.text} (${result.title})`,
              screenshot: '',
              nodeType: 'button' as const,
              elementType: button.type,
              parentPageId: result.id,
              depth
            });

            // 페이지에서 버튼으로의 연결선
            edges.push({
              from: result.id,
              to: buttonId
            });
            
            // 링크 버튼이 가리키는 페이지로의 연결선
            if (button.href) {
              const targetPage = results.find(r => r.url === button.href);
              if (targetPage) {
                edges.push({
                  from: buttonId,
                  to: targetPage.id
                });
              }
            }
          });
        }

        // 폼 노드 추가
        if (result.elements?.forms && result.elements.forms.length > 0) {
          result.elements.forms.forEach((form, index) => {
            const formId = `${result.id}_form_${index}`;
            
            nodes.push({
              id: formId,
              label: `${form.name} (${form.fields} fields)`,
              color: elementColors['form'],
              type: 'form',
              url: result.url,
              title: `${form.name} Form (${result.title})`,
              screenshot: '',
              nodeType: 'form' as const,
              elementType: 'form',
              parentPageId: result.id,
              depth
            });

            // 페이지에서 폼으로의 연결선
            edges.push({
              from: result.id,
              to: formId
            });
          });
        }
      }
    });
    
    // 페이지 간 링크 연결선 생성 (이미 메뉴/버튼으로 연결되지 않은 경우만)
    results.forEach(result => {
      result.links.forEach(link => {
        const targetResult = results.find(r => r.url === link);
        if (targetResult && !edges.some(e => e.from === result.id && e.to === targetResult.id)) {
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