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
export declare class CrawlerService {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    startCrawling(userId: number, targetUrl: string, maxPages?: number): Promise<string>;
    private performCrawling;
    private removeCookiePopups;
    private crawlSinglePage;
    private extractLinks;
    private generateNetworkData;
    private generateVisualizationHtml;
    private sanitizeFilename;
    private sleep;
    private randomDelay;
    private isSameDomain;
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
    getPreviewAnalysis(url: string): Promise<AnalysisResult>;
    private performDFSCrawl;
    downloadFile(analysisId: string, userId: number, fileType: 'png' | 'html', pageId: string): Promise<{
        filePath: string;
        filename: string;
        contentType: string;
    }>;
    private detectSPANavigation;
}
