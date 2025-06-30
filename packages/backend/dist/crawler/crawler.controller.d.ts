import { Response } from 'express';
import { CrawlerService } from './crawler.service';
import { PrismaService } from '../prisma/prisma.service';
export declare class CrawlerController {
    private crawlerService;
    private prisma;
    constructor(crawlerService: CrawlerService, prisma: PrismaService);
    getPreview(url: string, response: Response): Promise<import("./crawler.service").AnalysisResult>;
    startCrawling(req: any, body: {
        url: string;
        maxPages?: number;
    }): Promise<{
        analysisId: string;
        message: string;
        status: string;
    }>;
    getAnalysisStatus(req: any, analysisId: string): Promise<{
        id: string;
        status: string;
        progress: number;
        pageCount: number;
        url: string;
        title: string | null;
    }>;
    getAnalysis(req: any, analysisId: string): Promise<{
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
    getUserAnalyses(req: any, limit?: string): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        url: string;
        title: string | null;
        status: string;
        progress: number;
        pageCount: number;
    }[]>;
    downloadFile(req: any, analysisId: string, pageId: string, fileType: 'png' | 'html', res: Response): Promise<void>;
    getScreenshot(analysisId: string, filename: string, res: Response): Promise<void>;
    getTempScreenshot(tempId: string, filename: string, res: Response): Promise<void>;
}
