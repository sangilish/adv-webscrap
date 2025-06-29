import { Response } from 'express';
import { CrawlerService } from './crawler.service';
import { PrismaService } from '../prisma/prisma.service';
export declare class CrawlerController {
    private crawlerService;
    private prisma;
    constructor(crawlerService: CrawlerService, prisma: PrismaService);
    startAnalysis(body: {
        url: string;
        maxPages?: number;
    }, req: any): Promise<{
        analysisId: string;
        message: string;
        estimatedTime: string;
    }>;
    getAnalysis(analysisId: string, req: any): Promise<{
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
    }>;
    getVisualization(analysisId: string, req: any, res: Response): Promise<void>;
    getScreenshot(analysisId: string, filename: string, req: any, res: Response): Promise<void>;
    downloadFile(analysisId: string, body: {
        fileType: 'png' | 'html' | 'json';
    }, req: any): Promise<{
        downloadUrl: string;
        fileName: string;
        message: string;
    }>;
    downloadFileStream(analysisId: string, fileType: string, req: any, res: Response): Promise<void>;
    getAnalysisHistory(req: any): Promise<{
        analyses: {
            id: string;
            url: string;
            title: string | null;
            status: string;
            pageCount: number;
            createdAt: Date;
            updatedAt: Date;
        }[];
        total: number;
    }>;
    getAnalysisStatus(analysisId: string, req: any): Promise<{
        id: string;
        status: string;
        pageCount: number;
        progress: number;
        message: string;
    }>;
    private getStatusMessage;
}
