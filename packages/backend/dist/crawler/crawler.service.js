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
                        const links = Array.from(document.querySelectorAll('a[href]'))
                            .map(a => a.href)
                            .filter(href => href.startsWith('http') && !href.includes('#'))
                            .slice(0, 20);
                        const images = Array.from(document.querySelectorAll('img[src]'))
                            .map(img => img.src)
                            .filter(src => src.startsWith('http'))
                            .slice(0, 10);
                        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
                            .slice(0, 20)
                            .map(h => ({
                            level: h.tagName.toLowerCase(),
                            text: h.textContent?.trim() || ''
                        }));
                        const forms = document.querySelectorAll('form').length;
                        const buttons = Array.from(document.querySelectorAll('button'))
                            .slice(0, 10)
                            .map(btn => btn.textContent?.trim() || '')
                            .filter(t => t);
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
                        waitUntil: 'domcontentloaded',
                        timeout: 10000
                    });
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
                        const links = Array.from(document.querySelectorAll('a[href]'))
                            .map(a => {
                            const href = a.href;
                            try {
                                const linkUrl = new URL(href);
                                if (linkUrl.protocol === 'http:' || linkUrl.protocol === 'https:') {
                                    return linkUrl.toString();
                                }
                            }
                            catch { }
                            return null;
                        })
                            .filter((link) => link !== null)
                            .filter((link, index, arr) => arr.indexOf(link) === index);
                        const title = document.title || '';
                        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                            .map(h => ({
                            level: h.tagName.toLowerCase(),
                            text: h.textContent?.trim() || ''
                        }))
                            .filter(h => h.text.length > 0)
                            .slice(0, 5);
                        const textContent = document.body.textContent?.trim().substring(0, 300) || '';
                        const wordCount = textContent.split(/\s+/).length;
                        return {
                            title,
                            links: links.slice(0, 15),
                            headings,
                            textContent,
                            wordCount
                        };
                    });
                    const filteredLinks = filterSameDomainLinks(pageData.links);
                    const result = {
                        id: `preview_${Date.now()}_${allResults.length}_depth${depth}`,
                        url: pageUrl,
                        title: pageData.title,
                        pageType: this.classifyPageType(pageUrl, pageData.title),
                        links: filteredLinks,
                        images: [],
                        headings: pageData.headings,
                        forms: 0,
                        buttons: [],
                        textContent: pageData.textContent,
                        screenshotPath: '',
                        htmlPath: '',
                        timestamp: new Date().toISOString(),
                        metadata: {
                            wordCount: pageData.wordCount,
                            imageCount: 0,
                            linkCount: filteredLinks.length
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
        if (urlLower.includes('/contact') || titleLower.includes('contact'))
            return '연락처';
        if (urlLower.includes('/about') || titleLower.includes('about'))
            return '소개페이지';
        if (urlLower.includes('/product') || titleLower.includes('product'))
            return '제품페이지';
        if (urlLower.includes('/service') || titleLower.includes('service'))
            return '서비스페이지';
        if (urlLower.includes('/blog') || titleLower.includes('blog'))
            return '블로그';
        if (urlLower.includes('/news') || titleLower.includes('news'))
            return '뉴스';
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
        results.forEach((result) => {
            if (!processedUrls.has(result.url)) {
                processedUrls.add(result.url);
                let color = '#6366f1';
                switch (result.pageType) {
                    case '홈페이지':
                        color = '#ef4444';
                        break;
                    case '소개페이지':
                        color = '#10b981';
                        break;
                    case '연락처':
                        color = '#f59e0b';
                        break;
                    case '제품페이지':
                        color = '#8b5cf6';
                        break;
                    case '서비스페이지':
                        color = '#06b6d4';
                        break;
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