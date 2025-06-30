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
const playwright_1 = require("playwright");
const fs = require("fs");
const path = require("path");
let CrawlerService = CrawlerService_1 = class CrawlerService {
    prisma;
    logger = new common_1.Logger(CrawlerService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    async startCrawling(userId, targetUrl, maxPages = 5) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { analyses: true }
        });
        if (!user) {
            throw new common_1.BadRequestException('User not found');
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
        this.performCrawling(analysis.id, targetUrl, maxPages, user.plan).catch((error) => {
            this.logger.error(`Crawling failed for analysis ${analysis.id}:`, error);
            this.prisma.analysis.update({
                where: { id: analysis.id },
                data: { status: 'failed' },
            });
        });
        return analysis.id;
    }
    async performCrawling(analysisId, startUrl, maxPages, userPlan) {
        const results = [];
        const visitedUrls = new Set();
        const baseUrl = new URL(startUrl).origin;
        const planLimits = {
            FREE: 100,
            PRO: 500,
            ENTERPRISE: 1000
        };
        const actualMaxPages = Math.min(maxPages, planLimits[userPlan] || 5);
        const outputDir = path.join(process.cwd(), 'uploads', analysisId);
        const screenshotsDir = path.join(outputDir, 'screenshots');
        const htmlDir = path.join(outputDir, 'html');
        await fs.promises.mkdir(screenshotsDir, { recursive: true });
        await fs.promises.mkdir(htmlDir, { recursive: true });
        const browser = await playwright_1.chromium.launch({
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
                page.on('pageerror', (err) => this.logger.error('Page error:', err));
                try {
                    console.log(`🔍 Loading page: ${currentUrl}`);
                    const response = await page.goto(currentUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });
                    if (!response || !response.ok()) {
                        console.log(`❌ Page load failed with status: ${response?.status()}`);
                        continue;
                    }
                    await page.waitForTimeout(3000);
                    console.log(`✅ Page loaded and ready: ${currentUrl}`);
                    const pageTitle = await page.title();
                    const pageContentLength = (await page.content()).length;
                    console.log(`📊 Page Debug Info:`);
                    console.log(`  - Title: "${pageTitle}"`);
                    console.log(`  - Content Length: ${pageContentLength} chars`);
                    console.log(`  - Response Status: ${response?.status()}`);
                    await page.setViewportSize({ width: 1280, height: 800 });
                    if (results.length === 0) {
                        console.log('🔍 Detecting SPA navigation patterns...');
                        const spaRoutes = await this.detectSPANavigation(page, baseUrl);
                        console.log(`🎯 Found ${spaRoutes.length} potential SPA routes`);
                        for (const route of spaRoutes) {
                            if (!visitedUrls.has(route) && !urlsToVisit.includes(route)) {
                                urlsToVisit.push(route);
                                console.log(`➕ Added SPA route to queue: ${route}`);
                            }
                        }
                    }
                    const result = await this.crawlSinglePage(page, currentUrl, outputDir);
                    results.push(result);
                    await this.prisma.analysis.update({
                        where: { id: analysisId },
                        data: {
                            pageCount: results.length,
                            progress: Math.round((results.length / actualMaxPages) * 100)
                        },
                    });
                    if (results.length < actualMaxPages) {
                        const links = await this.extractLinks(page);
                        for (const link of links) {
                            try {
                                const linkUrl = new URL(link);
                                if (linkUrl.origin === baseUrl && !visitedUrls.has(link) && !urlsToVisit.includes(link)) {
                                    urlsToVisit.push(link);
                                }
                            }
                            catch (e) {
                            }
                        }
                    }
                }
                catch (error) {
                    this.logger.error(`Error crawling ${currentUrl}:`, error);
                }
                finally {
                    await page.close();
                }
            }
            const networkData = this.generateNetworkData(results, {});
            const visualizationHtml = this.generateVisualizationHtml(networkData, results);
            const htmlPath = path.join(outputDir, 'visualization.html');
            await fs.promises.writeFile(htmlPath, visualizationHtml);
            await this.prisma.analysis.update({
                where: { id: analysisId },
                data: {
                    status: 'completed',
                    pageCount: results.length,
                    progress: 100,
                },
            });
            this.logger.log(`Crawling completed for analysis ${analysisId}. ${results.length} pages crawled.`);
        }
        catch (error) {
            this.logger.error(`Crawling failed for analysis ${analysisId}:`, error);
            await this.prisma.analysis.update({
                where: { id: analysisId },
                data: { status: 'failed' },
            });
        }
        finally {
            await browser.close();
        }
    }
    async removeCookiePopups(page) {
        const cookieSelectors = [
            '[id="didomi-notice"]',
            '[class*="didomi"]',
            '#didomi-popup',
            '#didomi-banner',
            '[id*="cookie"]',
            '[class*="cookie"]',
            '[data-testid*="cookie"]',
            '[aria-label*="cookie"]',
            '[id*="consent"]',
            '[class*="consent"]',
            '[data-testid*="consent"]',
            '[id*="gdpr"]',
            '[class*="gdpr"]',
            '[class*="banner"]',
            '[class*="popup"]',
            '[class*="modal"]',
            '[class*="overlay"]',
            '[role="dialog"]',
            '[role="banner"]',
            'div:has-text("cookie")',
            'div:has-text("consent")',
            'div:has-text("privacy")',
            'div:has-text("accept")'
        ];
        for (const selector of cookieSelectors) {
            try {
                await page.waitForTimeout(500);
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
                    }
                    catch (e) {
                    }
                }
            }
            catch (error) {
            }
        }
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
            }
            catch (error) {
            }
        }
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
        await page.waitForTimeout(2000);
    }
    async crawlSinglePage(page, url, outputDir) {
        const timestamp = new Date().toISOString();
        const pageId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        console.log(`🚀 페이지 로딩 시작: ${url}`);
        page.on('console', msg => {
            console.log(`[PAGE ${msg.type().toUpperCase()}] ${msg.text()}`);
        });
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        console.log(`📄 페이지 로드 완료, SPA 렌더링 대기 중...`);
        await page.waitForLoadState('networkidle').catch(() => {
            console.log('⚠️ 네트워크 idle 대기 실패, DOM 로드로 대체');
            return page.waitForLoadState('domcontentloaded');
        });
        console.log(`⏳ SPA 렌더링을 위해 5초 대기...`);
        await page.waitForTimeout(5000);
        const isPreviewRun = path.basename(outputDir).startsWith('preview_');
        if (!isPreviewRun) {
            console.log(`🍪 쿠키 팝업 및 오버레이 제거 중...`);
            await this.removeCookiePopups(page);
            await page.waitForTimeout(1000);
        }
        console.log(`📜 스크롤하여 지연 로딩 컨텐츠 트리거...`);
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            window.scrollTo(0, 0);
        });
        await page.waitForTimeout(2000);
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
        const htmlContent = await page.content();
        const htmlFilename = `${pageId}.html`;
        const htmlDir = path.join(outputDir, 'html');
        if (!fs.existsSync(htmlDir)) {
            fs.mkdirSync(htmlDir, { recursive: true });
        }
        const htmlPath = path.join(htmlDir, htmlFilename);
        await fs.promises.writeFile(htmlPath, htmlContent);
        console.log(`🔍 링크 추출 시작: ${url}`);
        const navigationData = await page.evaluate(() => {
            const currentOrigin = location.origin;
            const rawLinks = Array.from(document.querySelectorAll('a[href]'))
                .map(a => a.href.trim())
                .filter(h => h &&
                !h.startsWith('javascript:') &&
                !h.startsWith('mailto:') &&
                !h.startsWith('tel:'));
            const links = Array.from(new Set(rawLinks.filter(h => {
                try {
                    return new URL(h).origin === currentOrigin;
                }
                catch {
                    return false;
                }
            })));
            const images = Array.from(document.querySelectorAll('img[src]'))
                .map(img => img.src)
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
                debugInfo: []
            };
        });
        console.log(`\n🔍 Link Extraction Debug for ${url}:`);
        console.log(`Found ${navigationData.links.length} valid links`);
        console.log(`Total links discovered: ${navigationData.allLinks ? navigationData.allLinks.length : 0}`);
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
            }, {});
            Object.entries(rejectionReasons).forEach(([reason, count]) => {
                debugText += `  - ${reason}: ${count} links\n`;
            });
            debugText += `\nFirst few rejected:\n`;
            rejected.slice(0, 5).forEach(d => debugText += `  - ${d.url} (${d.rejected}, ${d.source})\n`);
        }
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
            }, {});
            Object.entries(rejectionReasons).forEach(([reason, count]) => {
                console.log(`  - ${reason}: ${count} links`);
            });
        }
        let pageType = '일반페이지';
        const pathname = new URL(url).pathname.toLowerCase();
        const titleLower = navigationData.title.toLowerCase();
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
        else if (pathname.includes('dashboard') || titleLower.includes('dashboard')) {
            pageType = '대시보드';
        }
        const isPreview = path.basename(outputDir).startsWith('preview_');
        const screenshotUrl = isPreview
            ? `/temp/${path.basename(outputDir)}/screenshots/${screenshotFilename}`
            : `/uploads/${path.basename(outputDir)}/screenshots/${screenshotFilename}`;
        const htmlUrl = isPreview
            ? `/temp/${path.basename(outputDir)}/html/${htmlFilename}`
            : `/uploads/${path.basename(outputDir)}/html/${htmlFilename}`;
        console.log(`📊 Navigation data:`, {
            title: navigationData.title,
            linksFound: navigationData.links.length,
            debugEntries: navigationData.debugInfo?.length || 0
        });
        const result = {
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
    async extractLinks(page) {
        const base = new URL(page.url()).origin;
        await page.waitForSelector('nav, .sidebar, [role="menu"]', { timeout: 5000 }).catch(() => { });
        const anchors = await page.$$eval('a[href]', els => els
            .map(a => a.href)
            .filter(href => href.startsWith(window.location.origin) &&
            !/(javascript:|mailto:|tel:)/.test(href) &&
            !/\.(css|js|png|jpg|jpeg|gif|svg|ico|pdf|zip|mp4|mp3)([?#]|$)/i.test(href)));
        const btns = await page.$$eval('button[onclick]', els => els
            .map(b => {
            const m = b.getAttribute('onclick')?.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
            return m ? new URL(m[1], window.location.href).href : null;
        })
            .filter((u) => !!u && u.startsWith(window.location.origin)));
        const dataLinks = await page.$$eval('[data-href],[data-url]', els => els
            .map(el => el.getAttribute('data-href') || el.getAttribute('data-url'))
            .map(url => url ? new URL(url, window.location.href).href : null)
            .filter((u) => !!u && u.startsWith(window.location.origin)));
        const clickItems = await page.$$('nav button, nav li, [role="menuitem"]');
        const clickLinks = [];
        for (const item of clickItems) {
            try {
                const before = page.url();
                await item.click();
                await page.waitForLoadState('networkidle');
                const after = page.url();
                if (after !== before && after.startsWith(base)) {
                    clickLinks.push(after);
                }
                await page.goBack({ waitUntil: 'networkidle' });
            }
            catch {
            }
            finally {
                await page.waitForTimeout(500);
            }
        }
        const all = [...anchors, ...btns, ...dataLinks, ...clickLinks];
        return Array.from(new Set(all));
    }
    generateNetworkData(results, sitemap) {
        const nodes = [];
        const edges = [];
        const processedUrls = new Set();
        results.forEach((result, index) => {
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
                    case '대시보드':
                        color = '#ec4899';
                        break;
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
    sanitizeFilename(url) {
        return url.replace(/[^0-9a-zA-Z]+/g, '_').slice(0, 200);
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    randomDelay(min = 1000, max = 3000) {
        return Math.random() * (max - min) + min;
    }
    isSameDomain(url, baseUrl) {
        try {
            const urlObj = new URL(url);
            const baseUrlObj = new URL(baseUrl);
            return urlObj.hostname === baseUrlObj.hostname;
        }
        catch {
            return false;
        }
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
    async getPreviewAnalysis(url) {
        this.logger.log(`Starting preview analysis for: ${url}`);
        try {
            new URL(url);
            const { results, sitemap } = await this.performDFSCrawl(url, 2, 5);
            const networkData = this.generateNetworkData(results, sitemap);
            return {
                results,
                networkData,
                totalPages: results.length,
                isPreview: true,
                previewLimit: 5,
                message: `미리보기로 ${results.length}개 페이지를 분석했습니다. 전체 분석을 원하시면 로그인해주세요.`
            };
        }
        catch (error) {
            this.logger.error(`Preview analysis failed for ${url}:`, error);
            throw error;
        }
    }
    async performDFSCrawl(startUrl, maxDepth = 3, maxPages = 5) {
        const timestamp = Date.now();
        const outputDir = path.join(process.cwd(), 'temp', `preview_${timestamp}`);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        let browser = null;
        let context = null;
        try {
            browser = await playwright_1.chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-dev-shm-usage']
            });
            context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                viewport: { width: 1400, height: 900 }
            });
            const page = await context.newPage();
            const visited = new Set();
            const sitemap = {};
            const results = [];
            const dfs = async (url, depth) => {
                if (depth > maxDepth || visited.has(url) || results.length >= maxPages) {
                    this.logger.log(`⏭️  Skipping ${url} - depth:${depth}/${maxDepth}, visited:${visited.has(url)}, results:${results.length}/${maxPages}`);
                    return;
                }
                this.logger.log(`🔍 [DEPTH ${depth}] Starting crawl: ${url}`);
                visited.add(url);
                try {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await page.waitForTimeout(3000);
                    if (depth === 0) {
                        console.log('🔍 Detecting SPA navigation patterns...');
                        const spaRoutes = await this.detectSPANavigation(page, new URL(startUrl).origin);
                        console.log(`🎯 Found ${spaRoutes.length} potential SPA routes`);
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
                    const childLinks = result.links.filter(link => this.isSameDomain(link, startUrl));
                    sitemap[url] = childLinks;
                    this.logger.log(`🔗 [DEPTH ${depth}] Same-domain child links: ${childLinks.length}`);
                    childLinks.forEach((link, index) => {
                        this.logger.log(`   ${index + 1}. ${link}`);
                    });
                    for (const childUrl of childLinks) {
                        if (results.length >= maxPages) {
                            this.logger.log(`🛑 Reached max pages limit (${maxPages})`);
                            break;
                        }
                        if (!visited.has(childUrl)) {
                            this.logger.log(`⏳ [DEPTH ${depth}] Preparing to crawl child: ${childUrl}`);
                            const delay = this.randomDelay(1000, 3000);
                            this.logger.log(`⏰ Waiting ${Math.round(delay)}ms before next crawl...`);
                            await this.sleep(delay);
                            await dfs(childUrl, depth + 1);
                        }
                        else {
                            this.logger.log(`⏭️  Already visited: ${childUrl}`);
                        }
                    }
                }
                catch (error) {
                    this.logger.warn(`❌ [DEPTH ${depth}] Failed to crawl ${url}: ${error.message}`);
                    sitemap[url] = [];
                }
            };
            await dfs(startUrl, 0);
            const sitemapPath = path.join(outputDir, 'sitemap.json');
            fs.writeFileSync(sitemapPath, JSON.stringify(sitemap, null, 2));
            this.logger.log(`Crawl finished - ${results.length} pages crawled`);
            return { results, sitemap };
        }
        finally {
            if (context)
                await context.close();
            if (browser)
                await browser.close();
        }
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
    async detectSPANavigation(page, baseUrl) {
        const discoveredUrls = new Set();
        console.log('🔍 Detecting SPA navigation patterns...');
        page.on('request', request => {
            const url = request.url();
            const resourceType = request.resourceType();
            if ((resourceType === 'xhr' || resourceType === 'fetch') && url.startsWith(baseUrl)) {
                console.log(`🌐 Detected API call: ${url}`);
                try {
                    const urlObj = new URL(url);
                    const pathSegments = urlObj.pathname.split('/').filter(s => s);
                    if (pathSegments.includes('pages') || pathSegments.includes('routes')) {
                        discoveredUrls.add(url);
                    }
                }
                catch (e) {
                }
            }
        });
        await page.evaluate(() => {
            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;
            history.pushState = function (...args) {
                console.log('🔀 pushState:', args[2]);
                window.postMessage({ type: 'navigation', url: args[2] }, '*');
                return originalPushState.apply(history, args);
            };
            history.replaceState = function (...args) {
                console.log('🔀 replaceState:', args[2]);
                window.postMessage({ type: 'navigation', url: args[2] }, '*');
                return originalReplaceState.apply(history, args);
            };
        });
        await page.exposeFunction('onNavigation', (url) => {
            if (url && url.startsWith('/')) {
                discoveredUrls.add(new URL(url, baseUrl).href);
            }
        });
        await page.evaluate(() => {
            window.addEventListener('message', (e) => {
                if (e.data.type === 'navigation' && e.data.url) {
                    window.onNavigation(e.data.url);
                }
            });
        });
        const jsRoutes = await page.evaluate(() => {
            const routes = new Set();
            if (window.__NEXT_DATA__) {
                const nextData = window.__NEXT_DATA__;
                console.log('🔷 Found Next.js data:', nextData);
                if (nextData.page)
                    routes.add(nextData.page);
                if (nextData.props?.pageProps?.href)
                    routes.add(nextData.props.pageProps.href);
                if (nextData.runtimeConfig?.routes) {
                    Object.values(nextData.runtimeConfig.routes).forEach((route) => {
                        if (typeof route === 'string')
                            routes.add(route);
                    });
                }
            }
            if (window.__reactRouterVersion) {
                console.log('⚛️ Found React Router');
                const routerElements = document.querySelectorAll('[data-route], [data-path]');
                routerElements.forEach(el => {
                    const route = el.getAttribute('data-route') || el.getAttribute('data-path');
                    if (route)
                        routes.add(route);
                });
            }
            if (window.$nuxt || window.__VUE__) {
                console.log('🟢 Found Vue/Nuxt');
                try {
                    const app = window.__VUE__ || window.$nuxt;
                    if (app.$router && app.$router.options && app.$router.options.routes) {
                        app.$router.options.routes.forEach((route) => {
                            if (route.path)
                                routes.add(route.path);
                        });
                    }
                }
                catch (e) {
                    console.error('Error extracting Vue routes:', e);
                }
            }
            return Array.from(routes);
        });
        jsRoutes.forEach(route => {
            try {
                const fullUrl = new URL(route, baseUrl);
                discoveredUrls.add(fullUrl.href);
            }
            catch (e) {
            }
        });
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
            for (const element of elements.slice(0, 5)) {
                try {
                    const isVisible = await element.isVisible();
                    if (!isVisible)
                        continue;
                    const beforeUrl = page.url();
                    await element.hover();
                    await page.waitForTimeout(500);
                    await element.click({ timeout: 2000 });
                    await page.waitForTimeout(1000);
                    const afterUrl = page.url();
                    if (afterUrl !== beforeUrl && afterUrl.startsWith(baseUrl)) {
                        discoveredUrls.add(afterUrl);
                        console.log(`✅ Discovered via click: ${afterUrl}`);
                        await page.goBack({ waitUntil: 'domcontentloaded' });
                    }
                }
                catch (e) {
                }
            }
        }
        console.log(`🎯 Found ${discoveredUrls.size} potential SPA routes`);
        discoveredUrls.forEach((route, i) => console.log(`  ${i + 1}. ${route}`));
        return Array.from(discoveredUrls);
    }
};
exports.CrawlerService = CrawlerService;
exports.CrawlerService = CrawlerService = CrawlerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CrawlerService);
//# sourceMappingURL=crawler.service.js.map