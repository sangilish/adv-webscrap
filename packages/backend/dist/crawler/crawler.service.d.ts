import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
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
    private supabaseService;
    private readonly logger;
    constructor(prisma: PrismaService, supabaseService: SupabaseService);
    startCrawling(userId: number, targetUrl: string, maxPages?: number, supabaseUserId?: string): Promise<string>;
    private performOptimizedCrawling;
    private fastUrlDiscovery;
    private parallelCrawl;
    private fastCrawlPage;
    private quickRemoveCookies;
    getPreviewAnalysis(url: string): Promise<AnalysisResult>;
    private classifyPageType;
    getPageDetails(url: string): Promise<{
        screenshotPath: string;
        htmlPath: string;
        title: string;
    }>;
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
        creditsUsed: number;
        userId: number;
    }>;
    downloadFile(analysisId: string, userId: number, fileType: 'png' | 'html', pageId: string): Promise<{
        filePath: string;
        filename: string;
        contentType: string;
    }>;
}
