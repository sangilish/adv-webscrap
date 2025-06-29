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
            FREE: 5,
            PRO: 100,
            ENTERPRISE: 1000
        };
        const actualMaxPages = Math.min(maxPages, planLimits[userPlan] || 5);
        const outputDir = path.join(process.cwd(), 'uploads', analysisId);
        const screenshotsDir = path.join(outputDir, 'screenshots');
        const htmlDir = path.join(outputDir, 'html');
        await fs.promises.mkdir(screenshotsDir, { recursive: true });
        await fs.promises.mkdir(htmlDir, { recursive: true });
        const browser = await playwright_1.chromium.launch({ headless: true });
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
                    await this.removeCookiePopups(page);
                    const result = await this.extractPageData(page, currentUrl, analysisId, screenshotsDir, htmlDir);
                    results.push(result);
                    await this.prisma.analysis.update({
                        where: { id: analysisId },
                        data: {
                            pageCount: results.length,
                            progress: Math.round((results.length / actualMaxPages) * 100)
                        },
                    });
                    if (results.length < actualMaxPages) {
                        const links = await page.$$eval('a[href]', (anchors) => anchors.map(a => a.href).filter(href => href && href.startsWith('http')));
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
            const networkData = this.generateNetworkData(results);
            const visualizationHtml = this.generateVisualizationHtml(networkData, results);
            const htmlPath = path.join(outputDir, 'visualization.html');
            await fs.promises.writeFile(htmlPath, visualizationHtml);
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
            }
            catch (error) {
            }
        }
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
            }
            catch (error) {
            }
        }
    }
    async extractPageData(page, url, analysisId, screenshotsDir, htmlDir) {
        const timestamp = new Date().toISOString();
        const urlHash = Buffer.from(url).toString('base64').replace(/[/+=]/g, '-');
        const pageId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const screenshotFilename = `${pageId}.png`;
        const screenshotPath = path.join(screenshotsDir, screenshotFilename);
        await page.screenshot({
            path: screenshotPath,
            fullPage: true,
            type: 'png'
        });
        const htmlContent = await page.content();
        const htmlFilename = `${pageId}.html`;
        const htmlPath = path.join(htmlDir, htmlFilename);
        await fs.promises.writeFile(htmlPath, htmlContent);
        const pageData = await page.evaluate(() => {
            const title = document.title || '';
            const links = Array.from(document.querySelectorAll('a[href]'))
                .map(a => a.href)
                .filter(href => href && !href.startsWith('javascript:') && !href.startsWith('mailto:'));
            const images = Array.from(document.querySelectorAll('img[src]'))
                .map(img => img.src)
                .filter(src => src);
            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
                .map(h => ({
                level: h.tagName.toLowerCase(),
                text: h.textContent?.trim() || ''
            }))
                .filter(h => h.text);
            const forms = document.querySelectorAll('form').length;
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
        const pageType = this.classifyPageType(url, pageData.title, pageData.headings);
        const isPreview = analysisId.startsWith('preview_');
        const screenshotUrl = isPreview
            ? `/temp/${analysisId}/screenshots/${screenshotFilename}`
            : `/uploads/${analysisId}/screenshots/${screenshotFilename}`;
        const htmlUrl = isPreview
            ? `/temp/${analysisId}/html/${htmlFilename}`
            : `/uploads/${analysisId}/html/${htmlFilename}`;
        const result = {
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
    classifyPageType(url, title, headings) {
        const urlLower = url.toLowerCase();
        const titleLower = title.toLowerCase();
        if (urlLower.includes('/blog') || urlLower.includes('/news') || titleLower.includes('blog')) {
            return 'blog';
        }
        else if (urlLower.includes('/product') || urlLower.includes('/shop') || titleLower.includes('product')) {
            return 'product';
        }
        else if (urlLower.includes('/about') || titleLower.includes('about')) {
            return 'about';
        }
        else if (urlLower.includes('/contact') || titleLower.includes('contact')) {
            return 'contact';
        }
        else if (url === new URL(url).origin || urlLower.endsWith('/') && urlLower.split('/').length <= 4) {
            return 'homepage';
        }
        return 'page';
    }
    generateNetworkData(results) {
        const nodes = results.map(result => ({
            id: result.id,
            label: result.title || 'Untitled',
            color: this.getColorByPageType(result.pageType),
            type: result.pageType,
            url: result.url,
            title: result.title,
            screenshot: result.screenshotPath
        }));
        const edges = [];
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
    getColorByPageType(pageType) {
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
        const tempId = `preview_${Date.now()}`;
        const results = [];
        const visitedUrls = new Set();
        const tempDir = path.join(process.cwd(), 'temp', tempId);
        const screenshotsDir = path.join(tempDir, 'screenshots');
        const htmlDir = path.join(tempDir, 'html');
        await fs.promises.mkdir(screenshotsDir, { recursive: true });
        await fs.promises.mkdir(htmlDir, { recursive: true });
        const browser = await playwright_1.chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        });
        try {
            const baseUrl = new URL(url).origin;
            const urlsToVisit = [url];
            const maxPages = 5;
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
                    await this.removeCookiePopups(page);
                    const result = await this.extractPageData(page, currentUrl, tempId, screenshotsDir, htmlDir);
                    results.push(result);
                    if (results.length < maxPages) {
                        const links = await page.$$eval('a[href]', (anchors) => anchors.map(a => a.href).filter(href => href && href.startsWith('http')));
                        for (const link of links.slice(0, 10)) {
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
            const networkData = this.generateNetworkData(results);
            this.logger.log(`Preview analysis completed for: ${url}, results: ${results.length}`);
            return {
                results,
                networkData,
                totalPages: results.length,
                isPreview: true,
                previewLimit: 5
            };
        }
        catch (error) {
            this.logger.error(`Preview analysis failed for ${url}:`, error);
            const mockResults = [
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
        }
        finally {
            await browser.close();
        }
    }
    async crawlSinglePage(page, url, tempId, screenshotsDir, htmlDir, results, visitedUrls) {
        if (visitedUrls.has(url))
            return;
        visitedUrls.add(url);
        this.logger.log(`Crawling: ${url} (${visitedUrls.size})`);
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
            await this.removeCookiePopups(page);
            const result = await this.extractPageData(page, url, tempId, screenshotsDir, htmlDir);
            results.push(result);
        }
        catch (error) {
            this.logger.error(`Error crawling ${url}:`, error);
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
};
exports.CrawlerService = CrawlerService;
exports.CrawlerService = CrawlerService = CrawlerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CrawlerService);
//# sourceMappingURL=crawler.service.js.map