import { PrismaService } from '../prisma/prisma.service';
export interface CrawlResult {
    id: string;
    url: string;
    title: string;
    pageType: string;
    links: string[];
    images: string[];
    headings: {
        level: string;
        text: string;
    }[];
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
export declare class CrawlerService {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    startCrawling(userId: number, targetUrl: string, maxPages?: number): Promise<string>;
    private performCrawling;
    private removeCookiePopups;
    private extractPageData;
    private classifyPageType;
    private generateNetworkData;
    private getColorByPageType;
    getUserAnalyses(userId: number, limit?: number): Promise<{
        id: string;
        url: string;
        title: string | null;
        status: string;
        progress: number;
        pageCount: number;
        createdAt: Date;
        updatedAt: Date;
    }[]>;
    getAnalysis(analysisId: string, userId: number): Promise<{
        resultData: any;
        id: string;
        userId: number;
        url: string;
        title: string | null;
        status: string;
        progress: number;
        pageCount: number;
        screenshotPath: string | null;
        htmlPath: string | null;
        createdAt: Date;
        updatedAt: Date;
    }>;
    getPreviewAnalysis(url: string): Promise<any>;
    private crawlSinglePage;
    downloadFile(analysisId: string, userId: number, fileType: 'png' | 'html', pageId: string): Promise<{
        filePath: string;
        filename: string;
        contentType: string;
    }>;
    private generateVisualizationHtml;
}
