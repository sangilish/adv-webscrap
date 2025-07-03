"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var CrawlerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrawlerService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../prisma/prisma.service");
const supabase_service_1 = require("../supabase/supabase.service");
const playwright_1 = require("playwright");
const fs = require("fs");
const path = require("path");
const pLimit = (require('p-limit').default ?? require('p-limit'));
let CrawlerService = CrawlerService_1 = class CrawlerService {
    prisma;
    supabaseService;
    logger = new common_1.Logger(CrawlerService_1.name);
    constructor(prisma, supabaseService) {
        this.prisma = prisma;
        this.supabaseService = supabaseService;
    }
    async startCrawling(userId, targetUrl, maxPages = 5, supabaseUserId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { analyses: true }
        });
        if (!user) {
            throw new common_1.BadRequestException('User not found');
        }
        let supabaseProfile = null;
        if (supabaseUserId) {
            try {
                supabaseProfile = await this.supabaseService.getUserProfile(supabaseUserId);
            }
            catch (error) {
                this.logger.warn('Supabase profile not found:', error.message);
            }
        }
        const currentMonth = new Date();
        currentMonth.setDate(1);
        currentMonth.setHours(0, 0, 0, 0);
        const monthlyAnalyses = user.analyses.filter(analysis => new Date(analysis.createdAt) >= currentMonth);
        if (user.plan === 'FREE' && monthlyAnalyses.length >= 10) {
            throw new common_1.BadRequestException('Monthly crawling limit reached. Please upgrade to Pro.');
        }
        const analysis = await this.prisma.analysis.create({
            data: {
                userId,
                url: targetUrl,
                status: 'running',
            },
        });
        let supabaseAnalysis = null;
        if (supabaseUserId) {
            try {
                supabaseAnalysis = await this.supabaseService.saveAnalysis(supabaseUserId, {
                    url: targetUrl,
                    status: 'running',
                    progress: 0
                });
            }
            catch (error) {
                this.logger.warn('Failed to save analysis to Supabase:', error.message);
            }
        }
        this.performOptimizedCrawling(analysis.id, targetUrl, maxPages, user.plan, supabaseUserId, supabaseAnalysis?.id).catch((error) => {
            this.logger.error(`Crawling failed for analysis ${analysis.id}:`, error);
            this.prisma.analysis.update({
                where: { id: analysis.id },
                data: { status: 'failed' },
            });
            if (supabaseUserId && supabaseAnalysis?.id) {
                this.supabaseService.updateAnalysis(supabaseAnalysis.id, {
                    status: 'failed'
                }).catch(err => this.logger.warn('Failed to update Supabase analysis status:', err.message));
            }
        });
        return analysis.id;
    }
    async performOptimizedCrawling(analysisId, startUrl, maxPages, userPlan, supabaseUserId, supabaseAnalysisId) {
        const startTime = Date.now();
        const results = [];
        const visitedUrls = new Set();
        const baseUrl = new URL(startUrl).origin;
        const sitemap = {};
        const planLimits = {
            FREE: 100,
            PRO: 500,
            ENTERPRISE: 1000
        };
        const actualMaxPages = Math.min(maxPages, planLimits[userPlan] || 5);
        const outputDir = path.join(process.cwd(), 'uploads', analysisId);
        const browser = await playwright_1.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage']
        });
        try {
            this.logger.log('🚀 Phase 1: Fast URL Discovery');
            const discoveredUrls = await this.fastUrlDiscovery(browser, startUrl, actualMaxPages);
            this.logger.log('🚀 Phase 2: Parallel Content Extraction');
            const crawlResults = await this.parallelCrawl(browser, Array.from(discoveredUrls).slice(0, actualMaxPages), outputDir, analysisId);
            results.push(...crawlResults);
            const networkData = this.generateNetworkData(results, sitemap);
            const visualizationHtml = this.generateVisualizationHtml(networkData, results);
            const htmlPath = path.join(outputDir, 'visualization.html');
            await fs.promises.writeFile(htmlPath, visualizationHtml);
            await this.prisma.analysis.update({
                where: { id: analysisId },
                data: {
                    status: 'completed',
                    pageCount: results.length,
                    progress: 100,
                    title: results[0]?.title || 'Website Analysis'
                },
            });
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
                }
                catch (error) {
                    this.logger.warn('Failed to update Supabase analysis:', error.message);
                }
            }
            const duration = (Date.now() - startTime) / 1000;
            this.logger.log(`✅ Crawling completed in ${duration}s. ${results.length} pages crawled.`);
        }
        catch (error) {
            this.logger.error(`Crawling failed:`, error);
            await this.prisma.analysis.update({
                where: { id: analysisId },
                data: { status: 'failed' },
            });
        }
        finally {
            await browser.close();
        }
    }
    async fastUrlDiscovery(browser, startUrl, maxUrls) {
        this.logger.log(`Starting URL discovery for: ${startUrl}`);
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (compatible; WebCrawler/1.0)',
            viewport: { width: 1280, height: 800 }
        });
        const page = await context.newPage();
        const discoveredUrls = new Set([startUrl]);
        const baseUrl = new URL(startUrl).origin;
        const urlQueue = [startUrl];
        const processed = new Set();
        try {
            while (urlQueue.length > 0 && discoveredUrls.size < maxUrls) {
                const currentUrl = urlQueue.shift();
                if (processed.has(currentUrl))
                    continue;
                processed.add(currentUrl);
                this.logger.log(`Processing URL: ${currentUrl}`);
                try {
                    await page.goto(currentUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 10000
                    });
                    await page.waitForTimeout(500);
                    const links = await page.evaluate((baseUrl) => {
                        const urls = new Set();
                        document.querySelectorAll('a[href]').forEach(a => {
                            try {
                                const href = a.href;
                                const url = new URL(href);
                                if (url.origin === baseUrl && !href.includes('#')) {
                                    urls.add(href);
                                }
                            }
                            catch { }
                        });
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
                                }
                                catch { }
                            }
                        });
                        return Array.from(urls);
                    }, baseUrl);
                    this.logger.log(`Found ${links.length} links on ${currentUrl}`);
                    for (const link of links) {
                        if (!discoveredUrls.has(link) && discoveredUrls.size < maxUrls) {
                            discoveredUrls.add(link);
                            urlQueue.push(link);
                        }
                    }
                }
                catch (error) {
                    this.logger.warn(`Failed to discover URLs from ${currentUrl}: ${error.message}`);
                }
            }
        }
        finally {
            await context.close();
        }
        this.logger.log(`📊 Discovered ${discoveredUrls.size} URLs`);
        return discoveredUrls;
    }
    async parallelCrawl(browser, urls, outputDir, analysisId) {
        this.logger.log(`Starting parallel crawl for ${urls.length} URLs`);
        const results = [];
        const limit = pLimit(5);
        const contexts = await Promise.all(Array(Math.min(5, urls.length)).fill(0).map(() => browser.newContext({
            userAgent: 'Mozilla/5.0 (compatible; WebCrawler/1.0)',
            viewport: { width: 1280, height: 800 }
        })));
        let contextIndex = 0;
        const crawlTasks = urls.map((url, index) => limit(async () => {
            const context = contexts[contextIndex % contexts.length];
            contextIndex++;
            const page = await context.newPage();
            try {
                const result = await this.fastCrawlPage(page, url, outputDir, index, urls.length, analysisId);
                results.push(result);
                return result;
            }
            catch (error) {
                this.logger.error(`Failed to crawl ${url}:`, error);
                return null;
            }
            finally {
                await page.close();
            }
        }));
        await Promise.all(crawlTasks);
        await Promise.all(contexts.map(ctx => ctx.close()));
        this.logger.log(`Parallel crawl completed. Got ${results.filter(r => r !== null).length} results`);
        return results.filter(r => r !== null);
    }
    async fastCrawlPage(page, url, outputDir, index, total, analysisId) {
        const timestamp = new Date().toISOString();
        const pageId = `page_${Date.now()}_${index}`;
        this.logger.log(`🔍 Crawling (${index + 1}/${total}): ${url}`);
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            await page.waitForTimeout(1000);
            const cookiePromise = this.quickRemoveCookies(page);
            const [pageData, _] = await Promise.all([
                page.evaluate((baseUrl) => {
                    try {
                        const collectMenus = () => {
                            const menus = [];
                            const mainNavSelectors = [
                                'nav a', 'header a', '[role="navigation"] a',
                                '.nav a', '.navbar a', '.menu a', '.navigation a',
                                '[class*="nav-"] a', '[class*="menu-"] a'
                            ];
                            mainNavSelectors.forEach(selector => {
                                document.querySelectorAll(selector).forEach(el => {
                                    const link = el;
                                    const text = link.textContent?.trim() || '';
                                    const href = link.href || '';
                                    if (text && href && !href.includes('#') && text.length > 1) {
                                        const exists = menus.some(m => m.text === text && m.href === href);
                                        if (!exists) {
                                            menus.push({ text, href, type: 'main' });
                                        }
                                    }
                                });
                            });
                            const footerSelectors = ['footer a', '.footer a', '[class*="footer"] a'];
                            footerSelectors.forEach(selector => {
                                document.querySelectorAll(selector).forEach(el => {
                                    const link = el;
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
                        const collectButtons = () => {
                            const buttons = [];
                            const buttonElements = document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a.btn, a.button');
                            buttonElements.forEach(el => {
                                let text = '';
                                let type = 'button';
                                let action = '';
                                let href = '';
                                if (el.tagName === 'BUTTON') {
                                    text = el.textContent?.trim() || '';
                                    type = el.type || 'button';
                                }
                                else if (el.tagName === 'INPUT') {
                                    const input = el;
                                    text = input.value || input.placeholder || '';
                                    type = input.type;
                                }
                                else if (el.tagName === 'A') {
                                    const link = el;
                                    text = link.textContent?.trim() || '';
                                    href = link.href || '';
                                    type = 'link-button';
                                }
                                else {
                                    text = el.textContent?.trim() || el.getAttribute('aria-label') || '';
                                }
                                const onclick = el.getAttribute('onclick');
                                if (onclick) {
                                    action = onclick.substring(0, 50);
                                }
                                if (text && text.length > 0 && text.length < 50 &&
                                    !text.match(/^[\s\n]*$/) &&
                                    !text.toLowerCase().includes('cookie')) {
                                    buttons.push({ text, type, action, href });
                                }
                            });
                            return buttons;
                        };
                        const collectForms = () => {
                            const forms = [];
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
                        const collectLinks = () => {
                            const urlSet = new Set();
                            document.querySelectorAll('a[href]').forEach((a) => {
                                try {
                                    const href = a.href;
                                    const abs = new URL(href, location.href);
                                    if (abs.protocol.startsWith('http')) {
                                        urlSet.add(abs.toString());
                                    }
                                }
                                catch { }
                            });
                            document.querySelectorAll('router-link[to], nuxt-link[to]').forEach((el) => {
                                const to = el.getAttribute('to');
                                if (to) {
                                    try {
                                        urlSet.add(new URL(to, location.origin).toString());
                                    }
                                    catch { }
                                }
                            });
                            try {
                                const nextData = window.__NEXT_DATA__;
                                if (nextData) {
                                    if (typeof nextData.page === 'string') {
                                        urlSet.add(new URL(nextData.page, location.origin).toString());
                                    }
                                    const buildPages = nextData.__BUILD_MANIFEST?.sortedPages || [];
                                    buildPages.forEach((p) => {
                                        if (p) {
                                            urlSet.add(new URL(p, location.origin).toString());
                                        }
                                    });
                                }
                            }
                            catch { }
                            try {
                                const nuxtData = window.__NUXT__;
                                if (nuxtData && Array.isArray(nuxtData.routes)) {
                                    nuxtData.routes.forEach((r) => {
                                        if (r) {
                                            urlSet.add(new URL(r, location.origin).toString());
                                        }
                                    });
                                }
                            }
                            catch { }
                            document.querySelectorAll('[data-href], [data-url], [data-link]').forEach((el) => {
                                const dataHref = el.getAttribute('data-href') ||
                                    el.getAttribute('data-url') ||
                                    el.getAttribute('data-link');
                                if (dataHref) {
                                    try {
                                        urlSet.add(new URL(dataHref, location.origin).toString());
                                    }
                                    catch { }
                                }
                            });
                            return Array.from(urlSet);
                        };
                        const links = collectLinks();
                        const menus = collectMenus();
                        const buttons = collectButtons();
                        const forms = collectForms();
                        const title = document.title || '';
                        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                            .map(h => ({
                            level: h.tagName.toLowerCase(),
                            text: h.textContent?.trim() || ''
                        }))
                            .filter(h => h.text.length > 0)
                            .slice(0, 5);
                        const images = Array.from(document.querySelectorAll('img'))
                            .map(img => {
                            const imgEl = img;
                            const srcAttr = imgEl.getAttribute('src') || imgEl.getAttribute('data-src');
                            const src = srcAttr || imgEl.src || '';
                            const alt = imgEl.alt || '';
                            const isExternal = src.startsWith('http') && !src.includes(location.hostname);
                            return { src, alt, isExternal };
                        })
                            .filter(img => img.src && img.src !== '' && !img.src.includes('data:'))
                            .slice(0, 20);
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
                            links: links.slice(0, 30),
                            headings,
                            menus,
                            buttons,
                            forms,
                            images: allImages,
                            textContent,
                            wordCount
                        };
                    }
                    catch (error) {
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
            const screenshotFilename = `${pageId}.png`;
            await fs.promises.mkdir(path.join(outputDir, 'screenshots'), { recursive: true });
            await fs.promises.mkdir(path.join(outputDir, 'html'), { recursive: true });
            const screenshotPathOnDisk = path.join(outputDir, 'screenshots', screenshotFilename);
            const screenshotPath = `/temp/${path.basename(outputDir)}/screenshots/${screenshotFilename}`;
            await page.screenshot({
                path: screenshotPathOnDisk,
                fullPage: true,
                type: 'png'
            });
            const htmlFilename = `${pageId}.html`;
            const htmlPathOnDisk = path.join(outputDir, 'html', htmlFilename);
            const htmlContent = await page.content();
            await fs.promises.writeFile(htmlPathOnDisk, htmlContent);
            let pageType = '일반페이지';
            const pathname = new URL(url).pathname.toLowerCase();
            const titleLower = pageData.title.toLowerCase();
            if (pathname === '/' || pathname === '/home' || titleLower.includes('home')) {
                pageType = '홈페이지';
            }
            else if (pathname.includes('about') || titleLower.includes('about')) {
                pageType = '소개페이지';
            }
            else if (pathname.includes('contact') || titleLower.includes('contact')) {
                pageType = '연락처';
            }
            else if (pathname.includes('product') || titleLower.includes('product')) {
                pageType = '제품페이지';
            }
            else if (pathname.includes('service') || titleLower.includes('service')) {
                pageType = '서비스페이지';
            }
            await this.prisma.analysis.update({
                where: { id: analysisId },
                data: {
                    progress: Math.round(((index + 1) / total) * 100)
                },
            }).catch(() => { });
            const refinedTitle = this.refineTitle(url, pageData.title);
            const btnObjs = pageData.buttons.map((b) => typeof b === 'string' ? { text: b, type: 'button' } : b);
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
        }
        catch (error) {
            this.logger.error(`Failed to crawl page ${url}:`, error);
            throw error;
        }
    }
    async quickRemoveCookies(page) {
        try {
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
            const acceptSelectors = [
                'button:has-text("Accept")',
                'button:has-text("OK")',
                'button:has-text("Agree")',
                '[id*="accept"]',
                '[class*="accept"]'
            ];
            for (const selector of acceptSelectors) {
                await page.click(selector, { timeout: 1000 }).catch(() => { });
            }
        }
        catch {
        }
    }
    refineTitle(pageUrl, rawTitle) {
        const cleaned = (rawTitle || '').trim();
        const lower = cleaned.toLowerCase();
        if (!cleaned || lower === 'home' || lower === 'index' || lower === 'homepage') {
            const pathname = new URL(pageUrl).pathname.replace(/\/$/, '');
            if (!pathname || pathname === '' || pathname === '/')
                return 'Home';
            const slug = pathname.split('/').filter(Boolean).pop() || 'Page';
            return slug
                .replace(/[-_]/g, ' ')
                .replace(/\b\w/g, (c) => c.toUpperCase());
        }
        return cleaned;
    }
    filterButtons(buttons) {
        const noiseRegex = /(carousel|arrow|switch|index|닫기|열기|prev|next|menu)/i;
        const uniq = {};
        return buttons
            .filter((b) => b.text && b.text.length >= 2 && !noiseRegex.test(b.text))
            .filter((b) => {
            if (uniq[b.text])
                return false;
            uniq[b.text] = true;
            return true;
        })
            .slice(0, 8);
    }
    async getPreviewAnalysis(url) {
        this.logger.log(`=== getPreviewAnalysis START (링크 구조만 빠르게 탐색) ===`);
        this.logger.log(`Starting fast structure discovery for: ${url}`);
        let baseUrl;
        try {
            baseUrl = new URL(url);
        }
        catch {
            throw new common_1.BadRequestException('유효하지 않은 URL입니다.');
        }
        const baseDomain = baseUrl.hostname;
        this.logger.log(`URL validation passed: ${url}`);
        this.logger.log(`Base domain for filtering: ${baseDomain}`);
        const browser = await playwright_1.chromium.launch({ headless: true });
        try {
            const MAX_DEPTH = 3;
            const CONCURRENCY = 5;
            const MAX_LINKS_PER_PAGE = 15;
            const visited = new Set();
            const queue = [{ url, depth: 1 }];
            const allResults = [];
            const limit = pLimit(CONCURRENCY);
            const filterSameDomainLinks = (links) => {
                return links.filter(link => {
                    try {
                        const linkUrl = new URL(link);
                        return linkUrl.hostname === baseDomain;
                    }
                    catch {
                        return false;
                    }
                });
            };
            const processPage = async (pageUrl, depth, parentId) => {
                if (visited.has(pageUrl))
                    return;
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
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
                    await page.waitForTimeout(1500);
                    await page.evaluate(() => {
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
                                    el.click();
                                }
                                catch { }
                            });
                        });
                    }).catch(() => { });
                    await page.waitForTimeout(1000);
                    const pageData = await page.evaluate(() => {
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
                                    el.style.display = 'none';
                                }
                            });
                        });
                        const collectMenus = () => {
                            const menus = [];
                            const mainNavSelectors = [
                                'nav a', 'header a', '[role="navigation"] a',
                                '.nav a', '.navbar a', '.menu a', '.navigation a',
                                '[class*="nav-"] a', '[class*="menu-"] a'
                            ];
                            mainNavSelectors.forEach(selector => {
                                document.querySelectorAll(selector).forEach(el => {
                                    const link = el;
                                    const text = link.textContent?.trim() || '';
                                    const href = link.href || '';
                                    if (text && href && !href.includes('#') && text.length > 1) {
                                        const exists = menus.some(m => m.text === text && m.href === href);
                                        if (!exists) {
                                            menus.push({ text, href, type: 'main' });
                                        }
                                    }
                                });
                            });
                            const footerSelectors = ['footer a', '.footer a', '[class*="footer"] a'];
                            footerSelectors.forEach(selector => {
                                document.querySelectorAll(selector).forEach(el => {
                                    const link = el;
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
                        const collectButtons = () => {
                            const buttons = [];
                            const buttonElements = document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a.btn, a.button');
                            buttonElements.forEach(el => {
                                let text = '';
                                let type = 'button';
                                let action = '';
                                let href = '';
                                if (el.tagName === 'BUTTON') {
                                    text = el.textContent?.trim() || '';
                                    type = el.type || 'button';
                                }
                                else if (el.tagName === 'INPUT') {
                                    const input = el;
                                    text = input.value || input.placeholder || '';
                                    type = input.type;
                                }
                                else if (el.tagName === 'A') {
                                    const link = el;
                                    text = link.textContent?.trim() || '';
                                    href = link.href || '';
                                    type = 'link-button';
                                }
                                else {
                                    text = el.textContent?.trim() || el.getAttribute('aria-label') || '';
                                }
                                const onclick = el.getAttribute('onclick');
                                if (onclick) {
                                    action = onclick.substring(0, 50);
                                }
                                if (text && text.length > 0 && text.length < 50 &&
                                    !text.match(/^[\s\n]*$/) &&
                                    !text.toLowerCase().includes('cookie')) {
                                    buttons.push({ text, type, action, href });
                                }
                            });
                            return buttons;
                        };
                        const collectForms = () => {
                            const forms = [];
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
                        const collectLinks = () => {
                            const urlSet = new Set();
                            document.querySelectorAll('a[href]').forEach((a) => {
                                try {
                                    const href = a.href;
                                    const abs = new URL(href, location.href);
                                    if (abs.protocol.startsWith('http')) {
                                        urlSet.add(abs.toString());
                                    }
                                }
                                catch { }
                            });
                            document.querySelectorAll('router-link[to], nuxt-link[to]').forEach((el) => {
                                const to = el.getAttribute('to');
                                if (to) {
                                    try {
                                        urlSet.add(new URL(to, location.origin).toString());
                                    }
                                    catch { }
                                }
                            });
                            try {
                                const nextData = window.__NEXT_DATA__;
                                if (nextData) {
                                    if (typeof nextData.page === 'string') {
                                        urlSet.add(new URL(nextData.page, location.origin).toString());
                                    }
                                    const buildPages = nextData.__BUILD_MANIFEST?.sortedPages || [];
                                    buildPages.forEach((p) => {
                                        if (p) {
                                            urlSet.add(new URL(p, location.origin).toString());
                                        }
                                    });
                                }
                            }
                            catch { }
                            try {
                                const nuxtData = window.__NUXT__;
                                if (nuxtData && Array.isArray(nuxtData.routes)) {
                                    nuxtData.routes.forEach((r) => {
                                        if (r) {
                                            urlSet.add(new URL(r, location.origin).toString());
                                        }
                                    });
                                }
                            }
                            catch { }
                            document.querySelectorAll('[data-href], [data-url], [data-link]').forEach((el) => {
                                const dataHref = el.getAttribute('data-href') ||
                                    el.getAttribute('data-url') ||
                                    el.getAttribute('data-link');
                                if (dataHref) {
                                    try {
                                        urlSet.add(new URL(dataHref, location.origin).toString());
                                    }
                                    catch { }
                                }
                            });
                            return Array.from(urlSet);
                        };
                        const links = collectLinks();
                        const menus = collectMenus();
                        const buttons = collectButtons();
                        const forms = collectForms();
                        const title = document.title || '';
                        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                            .map(h => ({
                            level: h.tagName.toLowerCase(),
                            text: h.textContent?.trim() || ''
                        }))
                            .filter(h => h.text.length > 0)
                            .slice(0, 5);
                        const images = Array.from(document.querySelectorAll('img'))
                            .map(img => {
                            const imgEl = img;
                            const srcAttr = imgEl.getAttribute('src') || imgEl.getAttribute('data-src');
                            const src = srcAttr || imgEl.src || '';
                            const alt = imgEl.alt || '';
                            const isExternal = src.startsWith('http') && !src.includes(location.hostname);
                            return { src, alt, isExternal };
                        })
                            .filter(img => img.src && img.src !== '' && !img.src.includes('data:'))
                            .slice(0, 20);
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
                            links: links.slice(0, 30),
                            headings,
                            menus,
                            buttons,
                            forms,
                            images: allImages,
                            textContent,
                            wordCount
                        };
                    });
                    const filteredLinks = filterSameDomainLinks(pageData.links);
                    const refinedTitle = this.refineTitle(pageUrl, pageData.title);
                    const btnObjs2 = pageData.buttons.map((b) => typeof b === 'string' ? { text: b, type: 'button' } : b);
                    const cleanButtons = this.filterButtons(btnObjs2);
                    const result = {
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
                        screenshotPath: '',
                        htmlPath: '',
                        timestamp: new Date().toISOString(),
                        metadata: {
                            wordCount: pageData.wordCount,
                            imageCount: pageData.images.length,
                            linkCount: filteredLinks.length
                        },
                        elements: {
                            menus: pageData.menus || [],
                            buttons: pageData.buttons || [],
                            forms: pageData.forms || []
                        }
                    };
                    allResults.push(result);
                    if (depth < MAX_DEPTH) {
                        filteredLinks
                            .filter(link => !visited.has(link))
                            .slice(0, MAX_LINKS_PER_PAGE)
                            .forEach(link => {
                            queue.push({ url: link, depth: depth + 1, parentId: result.id });
                        });
                    }
                }
                catch (err) {
                    this.logger.warn(`Failed to discover structure for ${pageUrl}: ${err?.message}`);
                }
                finally {
                    await page.close();
                    await context.close();
                }
            };
            while (queue.length > 0) {
                const currentBatch = queue.splice(0, Math.min(queue.length, 8));
                await Promise.allSettled(currentBatch.map(({ url: pageUrl, depth, parentId }) => limit(() => processPage(pageUrl, depth, parentId))));
            }
            await browser.close();
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
        }
        catch (error) {
            this.logger.error(`❌ Error during structure discovery:`, error);
            await browser.close();
            throw error;
        }
    }
    classifyPageType(url, title) {
        const urlLower = url.toLowerCase();
        const titleLower = title.toLowerCase();
        const pathname = new URL(url).pathname.toLowerCase();
        if (pathname === '/' || pathname === '/index' || pathname === '/home')
            return '홈페이지';
        if (pathname.includes('/login') || pathname.includes('/signin'))
            return '로그인';
        if (pathname.includes('/signup') || pathname.includes('/register'))
            return '회원가입';
        if (pathname.includes('/logout') || pathname.includes('/signout'))
            return '로그아웃';
        if (pathname.includes('/about') || titleLower.includes('about'))
            return '소개페이지';
        if (pathname.includes('/contact') || titleLower.includes('contact'))
            return '연락처';
        if (pathname.includes('/company') || titleLower.includes('company'))
            return '회사정보';
        if (pathname.includes('/team') || titleLower.includes('team'))
            return '팀소개';
        if (pathname.includes('/product') || titleLower.includes('product'))
            return '제품페이지';
        if (pathname.includes('/service') || titleLower.includes('service'))
            return '서비스페이지';
        if (pathname.includes('/solution') || titleLower.includes('solution'))
            return '솔루션';
        if (pathname.includes('/pricing') || titleLower.includes('pricing'))
            return '가격정책';
        if (pathname.includes('/plans') || titleLower.includes('plan'))
            return '요금제';
        if (pathname.includes('/features') || titleLower.includes('feature'))
            return '기능소개';
        if (pathname.includes('/blog') || titleLower.includes('blog'))
            return '블로그';
        if (pathname.includes('/news') || titleLower.includes('news'))
            return '뉴스';
        if (pathname.includes('/article') || titleLower.includes('article'))
            return '기사';
        if (pathname.includes('/resource') || titleLower.includes('resource'))
            return '자료실';
        if (pathname.includes('/documentation') || pathname.includes('/docs'))
            return '문서';
        if (pathname.includes('/support') || titleLower.includes('support'))
            return '고객지원';
        if (pathname.includes('/help') || titleLower.includes('help'))
            return '도움말';
        if (pathname.includes('/faq') || titleLower.includes('faq'))
            return 'FAQ';
        if (pathname.includes('/career') || pathname.includes('/jobs'))
            return '채용정보';
        if (pathname.includes('/privacy') || titleLower.includes('privacy'))
            return '개인정보처리방침';
        if (pathname.includes('/terms') || titleLower.includes('terms'))
            return '이용약관';
        if (pathname.includes('/legal') || titleLower.includes('legal'))
            return '법적고지';
        return '일반페이지';
    }
    async getPageDetails(url) {
        this.logger.log(`Getting page details for: ${url}`);
        const browser = await playwright_1.chromium.launch({ headless: true });
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
            await this.quickRemoveCookies(page);
            const screenshotFilename = `page_${Date.now()}.png`;
            const screenshotPathOnDisk = path.join(outputDir, 'screenshots', screenshotFilename);
            await page.screenshot({
                path: screenshotPathOnDisk,
                fullPage: true
            });
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
        }
        catch (error) {
            this.logger.error(`Error getting page details for ${url}:`, error);
            await browser.close();
            throw error;
        }
    }
    generateNetworkData(results, sitemap) {
        const nodes = [];
        const edges = [];
        const processedUrls = new Set();
        const pageColors = {
            '홈페이지': '#ef4444',
            '소개페이지': '#10b981',
            '회사정보': '#10b981',
            '팀소개': '#10b981',
            '연락처': '#f59e0b',
            '제품페이지': '#8b5cf6',
            '서비스페이지': '#06b6d4',
            '솔루션': '#06b6d4',
            '가격정책': '#ec4899',
            '요금제': '#ec4899',
            '기능소개': '#8b5cf6',
            '블로그': '#f97316',
            '뉴스': '#f97316',
            '자료실': '#f97316',
            '문서': '#6366f1',
            '고객지원': '#14b8a6',
            '도움말': '#14b8a6',
            'FAQ': '#14b8a6',
            '로그인': '#64748b',
            '회원가입': '#64748b',
            '채용정보': '#84cc16',
            '개인정보처리방침': '#94a3b8',
            '이용약관': '#94a3b8',
            '법적고지': '#94a3b8',
            '일반페이지': '#6b7280'
        };
        const elementColors = {
            'main-menu': '#3b82f6',
            'sub-menu': '#60a5fa',
            'footer-menu': '#93c5fd',
            'button': '#a855f7',
            'submit': '#7c3aed',
            'link-button': '#c084fc',
            'form': '#fbbf24'
        };
        const resultsByDepth = {};
        results.forEach(result => {
            const depthMatch = result.id.match(/depth(\d+)/);
            const depth = depthMatch ? parseInt(depthMatch[1]) : 0;
            if (!resultsByDepth[depth])
                resultsByDepth[depth] = [];
            resultsByDepth[depth].push(result);
        });
        results.forEach((result) => {
            if (!processedUrls.has(result.url)) {
                processedUrls.add(result.url);
                const depthMatch = result.id.match(/depth(\d+)/);
                const depth = depthMatch ? parseInt(depthMatch[1]) : 0;
                const pageColor = pageColors[result.pageType] || pageColors['일반페이지'];
                nodes.push({
                    id: result.id,
                    label: result.title.substring(0, 40) + (result.title.length > 40 ? '...' : ''),
                    color: pageColor,
                    type: result.pageType,
                    url: result.url,
                    title: result.title,
                    screenshot: result.screenshotPath,
                    nodeType: 'page',
                    depth
                });
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
                            nodeType: 'menu',
                            elementType: `${menu.type}-menu`,
                            parentPageId: result.id,
                            depth
                        });
                        edges.push({
                            from: result.id,
                            to: menuId
                        });
                        const targetPage = results.find(r => r.url === menu.href);
                        if (targetPage) {
                            edges.push({
                                from: menuId,
                                to: targetPage.id
                            });
                        }
                    });
                }
                if (result.elements?.buttons && result.elements.buttons.length > 0) {
                    const importantButtons = result.elements.buttons.filter(btn => {
                        const text = btn.text.toLowerCase();
                        return !text.includes('cookie') &&
                            !text.includes('accept') &&
                            !text.includes('decline') &&
                            !text.includes('×') &&
                            !text.includes('x') &&
                            text.length > 2 &&
                            text.length < 30;
                    }).slice(0, 5);
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
                            nodeType: 'button',
                            elementType: button.type,
                            parentPageId: result.id,
                            depth
                        });
                        edges.push({
                            from: result.id,
                            to: buttonId
                        });
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
                            nodeType: 'form',
                            elementType: 'form',
                            parentPageId: result.id,
                            depth
                        });
                        edges.push({
                            from: result.id,
                            to: formId
                        });
                    });
                }
            }
        });
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
    generateVisualizationHtml(networkData, results) {
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
    async getUserAnalyses(userId, limit) {
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
    async getAnalysis(analysisId, userId) {
        const analysis = await this.prisma.analysis.findFirst({
            where: {
                id: analysisId,
                userId
            }
        });
        if (!analysis) {
            throw new common_1.BadRequestException('Analysis not found');
        }
        return {
            ...analysis,
            resultData: analysis.resultData ? JSON.parse(analysis.resultData) : null
        };
    }
    async downloadFile(analysisId, userId, fileType, pageId) {
        const analysis = await this.prisma.analysis.findFirst({
            where: {
                id: analysisId,
                userId,
                status: 'completed'
            }
        });
        if (!analysis) {
            throw new common_1.BadRequestException('Analysis not found or not completed');
        }
        const resultData = analysis.resultData ? JSON.parse(analysis.resultData) : null;
        if (!resultData?.results) {
            throw new common_1.BadRequestException('No results found');
        }
        const page = resultData.results.find(r => r.id === pageId);
        if (!page) {
            throw new common_1.BadRequestException('Page not found');
        }
        const filePath = fileType === 'png' ? page.screenshotPath : page.htmlPath;
        const fullPath = path.join(process.cwd(), filePath.replace('/uploads/', 'uploads/'));
        if (!fs.existsSync(fullPath)) {
            throw new common_1.BadRequestException('File not found');
        }
        return {
            filePath: fullPath,
            filename: path.basename(fullPath),
            contentType: fileType === 'png' ? 'image/png' : 'text/html'
        };
    }
};
exports.CrawlerService = CrawlerService;
exports.CrawlerService = CrawlerService = CrawlerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        supabase_service_1.SupabaseService])
], CrawlerService);
//# sourceMappingURL=crawler.service.js.map