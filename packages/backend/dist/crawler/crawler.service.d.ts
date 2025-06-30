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
    private performOptimizedCrawling;
    private fastUrlDiscovery;
    private parallelCrawl;
    private fastCrawlPage;
    private quickRemoveCookies;
    getPreviewAnalysis(url: string): Promise<AnalysisResult>;
    private generateNetworkData;
    private generateVisualizationHtml;
    getUserAnalyses(userId: number, limit?: number): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        url: string;
        title: string | null;
        status: string;
        progress: number;
        pageCount: number;
    }[]>;
    getAnalysis(analysisId: string, userId: number): Promise<{
        resultData: any;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        url: string;
        title: string | null;
        status: string;
        progress: number;
        pageCount: number;
        screenshotPath: string | null;
        htmlPath: string | null;
        userId: number;
    }>;
    downloadFile(analysisId: string, userId: number, fileType: 'png' | 'html', pageId: string): Promise<{
        filePath: string;
        filename: string;
        contentType: string;
    }>;
}
