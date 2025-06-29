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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrawlerController = void 0;
const common_1 = require("@nestjs/common");
const jwt_auth_guard_1 = require("../auth/jwt-auth.guard");
const crawler_service_1 = require("./crawler.service");
const prisma_service_1 = require("../prisma/prisma.service");
const fs = require("fs");
let CrawlerController = class CrawlerController {
    crawlerService;
    prisma;
    constructor(crawlerService, prisma) {
        this.crawlerService = crawlerService;
        this.prisma = prisma;
    }
    async getPreview(url, response) {
        console.log('Preview endpoint called with URL:', url);
        response.header('Access-Control-Allow-Origin', 'http://localhost:3000');
        response.header('Access-Control-Allow-Credentials', 'true');
        response.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
        response.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
        if (!url) {
            throw new common_1.BadRequestException('URL is required');
        }
        try {
            new URL(url);
        }
        catch (error) {
            throw new common_1.BadRequestException('Invalid URL format');
        }
        console.log('Calling crawlerService.getPreviewAnalysis...');
        const result = await this.crawlerService.getPreviewAnalysis(url);
        console.log('Service returned:', result);
        return result;
    }
    async startCrawling(req, body) {
        const { url, maxPages = 5 } = body;
        if (!url) {
            throw new common_1.BadRequestException('URL is required');
        }
        try {
            new URL(url);
        }
        catch (error) {
            throw new common_1.BadRequestException('Invalid URL format');
        }
        const analysisId = await this.crawlerService.startCrawling(req.user.userId, url, maxPages);
        return {
            analysisId,
            message: 'Crawling started successfully',
            status: 'running'
        };
    }
    async getAnalysisStatus(req, analysisId) {
        const analysis = await this.crawlerService.getAnalysis(analysisId, req.user.userId);
        return {
            id: analysis.id,
            status: analysis.status,
            progress: analysis.progress || 0,
            pageCount: analysis.pageCount || 0,
            url: analysis.url,
            title: analysis.title
        };
    }
    async getAnalysis(req, analysisId) {
        return this.crawlerService.getAnalysis(analysisId, req.user.userId);
    }
    async getUserAnalyses(req, limit) {
        const limitNum = limit ? parseInt(limit) : undefined;
        return this.crawlerService.getUserAnalyses(req.user.userId, limitNum);
    }
    async downloadFile(req, analysisId, pageId, fileType, res) {
        if (!['png', 'html'].includes(fileType)) {
            throw new common_1.BadRequestException('Invalid file type. Must be png or html');
        }
        const fileInfo = await this.crawlerService.downloadFile(analysisId, req.user.userId, fileType, pageId);
        const fileStream = fs.createReadStream(fileInfo.filePath);
        res.setHeader('Content-Type', fileInfo.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.filename}"`);
        fileStream.pipe(res);
    }
    async getScreenshot(analysisId, filename, res) {
        const imagePath = `uploads/${analysisId}/screenshots/${filename}`;
        const fullPath = require('path').join(process.cwd(), imagePath);
        if (!fs.existsSync(fullPath)) {
            throw new common_1.BadRequestException('Screenshot not found');
        }
        res.sendFile(fullPath);
    }
    async getTempScreenshot(tempId, filename, res) {
        const imagePath = `temp/${tempId}/screenshots/${filename}`;
        const fullPath = require('path').join(process.cwd(), imagePath);
        if (!fs.existsSync(fullPath)) {
            throw new common_1.BadRequestException('Screenshot not found');
        }
        res.sendFile(fullPath);
    }
};
exports.CrawlerController = CrawlerController;
__decorate([
    (0, common_1.Post)('preview'),
    __param(0, (0, common_1.Body)('url')),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getPreview", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Post)('start'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "startCrawling", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('analysis/:id/status'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getAnalysisStatus", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('analysis/:id'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getAnalysis", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('analyses'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getUserAnalyses", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('download/:analysisId/:pageId/:fileType'),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('analysisId')),
    __param(2, (0, common_1.Param)('pageId')),
    __param(3, (0, common_1.Param)('fileType')),
    __param(4, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "downloadFile", null);
__decorate([
    (0, common_1.Get)('screenshot/:analysisId/:filename'),
    __param(0, (0, common_1.Param)('analysisId')),
    __param(1, (0, common_1.Param)('filename')),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getScreenshot", null);
__decorate([
    (0, common_1.Get)('temp-screenshot/:tempId/:filename'),
    __param(0, (0, common_1.Param)('tempId')),
    __param(1, (0, common_1.Param)('filename')),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getTempScreenshot", null);
exports.CrawlerController = CrawlerController = __decorate([
    (0, common_1.Controller)('crawler'),
    __metadata("design:paramtypes", [crawler_service_1.CrawlerService,
        prisma_service_1.PrismaService])
], CrawlerController);
//# sourceMappingURL=crawler.controller.js.map