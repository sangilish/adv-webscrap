import { PrismaService } from '../prisma/prisma.service';
export interface CrawlResult {
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
    private generateVisualizationHtml;
    getAnalysis(analysisId: string, userId: number): Promise<({
        downloads: {
            id: string;
            createdAt: Date;
            userId: number;
            fileType: string;
            filePath: string;
            analysisId: string;
        }[];
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        url: string;
        title: string | null;
        status: string;
        pageCount: number;
        resultData: string | null;
        screenshotPath: string | null;
        htmlPath: string | null;
        userId: number;
    }) | null>;
    getUserAnalyses(userId: number): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        url: string;
        title: string | null;
        status: string;
        pageCount: number;
        resultData: string | null;
        screenshotPath: string | null;
        htmlPath: string | null;
        userId: number;
    }[]>;
}
