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
const path = require("path");
const fs = require("fs");
let CrawlerController = class CrawlerController {
    crawlerService;
    prisma;
    constructor(crawlerService, prisma) {
        this.crawlerService = crawlerService;
        this.prisma = prisma;
    }
    async startAnalysis(body, req) {
        const { url, maxPages = 5 } = body;
        const userId = req.user.userId;
        try {
            new URL(url);
        }
        catch {
            throw new common_1.BadRequestException('유효하지 않은 URL입니다.');
        }
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (!user) {
            throw new common_1.NotFoundException('사용자를 찾을 수 없습니다.');
        }
        if (maxPages > 5 && user.subscriptionType === 'free') {
            throw new common_1.ForbiddenException('무료 사용자는 최대 5페이지까지만 분석할 수 있습니다. 더 많은 페이지를 분석하려면 결제가 필요합니다.');
        }
        if (user.freeAnalysisCount >= 5 && user.subscriptionType === 'free') {
            throw new common_1.ForbiddenException('무료 분석 횟수를 모두 사용했습니다. 추가 분석을 위해서는 결제가 필요합니다.');
        }
        const analysisId = await this.crawlerService.startCrawling(userId, url, maxPages);
        if (user.subscriptionType === 'free') {
            await this.prisma.user.update({
                where: { id: userId },
                data: { freeAnalysisCount: user.freeAnalysisCount + 1 },
            });
        }
        return {
            analysisId,
            message: '분석이 시작되었습니다. 잠시 후 결과를 확인해주세요.',
            estimatedTime: `약 ${maxPages * 2}초`,
        };
    }
    async getAnalysis(analysisId, req) {
        const userId = req.user.userId;
        const analysis = await this.crawlerService.getAnalysis(analysisId, userId);
        if (!analysis) {
            throw new common_1.NotFoundException('분석 결과를 찾을 수 없습니다.');
        }
        return analysis;
    }
    async getVisualization(analysisId, req, res) {
        const userId = req.user.userId;
        const analysis = await this.crawlerService.getAnalysis(analysisId, userId);
        if (!analysis) {
            throw new common_1.NotFoundException('분석 결과를 찾을 수 없습니다.');
        }
        if (analysis.status !== 'completed') {
            throw new common_1.BadRequestException('분석이 아직 완료되지 않았습니다.');
        }
        const visualizationPath = path.join(process.cwd(), 'uploads', analysisId, 'visualization.html');
        if (!fs.existsSync(visualizationPath)) {
            throw new common_1.NotFoundException('시각화 파일을 찾을 수 없습니다.');
        }
        res.sendFile(visualizationPath);
    }
    async getScreenshot(analysisId, filename, req, res) {
        const userId = req.user.userId;
        const analysis = await this.crawlerService.getAnalysis(analysisId, userId);
        if (!analysis) {
            throw new common_1.NotFoundException('분석 결과를 찾을 수 없습니다.');
        }
        const screenshotPath = path.join(process.cwd(), 'uploads', analysisId, 'screenshots', filename);
        if (!fs.existsSync(screenshotPath)) {
            throw new common_1.NotFoundException('스크린샷을 찾을 수 없습니다.');
        }
        res.sendFile(screenshotPath);
    }
    async downloadFile(analysisId, body, req) {
        const { fileType } = body;
        const userId = req.user.userId;
        const analysis = await this.crawlerService.getAnalysis(analysisId, userId);
        if (!analysis) {
            throw new common_1.NotFoundException('분석 결과를 찾을 수 없습니다.');
        }
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (!user) {
            throw new common_1.NotFoundException('사용자를 찾을 수 없습니다.');
        }
        if (fileType === 'html' && user.subscriptionType !== 'pro') {
            throw new common_1.ForbiddenException('HTML 소스 다운로드는 프로 구독자만 이용할 수 있습니다.');
        }
        let filePath;
        let fileName;
        switch (fileType) {
            case 'png':
                filePath = path.join(process.cwd(), 'uploads', analysisId, 'visualization.html');
                fileName = `${analysis.title || 'analysis'}-map.png`;
                break;
            case 'html':
                filePath = path.join(process.cwd(), 'uploads', analysisId, 'visualization.html');
                fileName = `${analysis.title || 'analysis'}-visualization.html`;
                break;
            case 'json':
                filePath = path.join(process.cwd(), 'uploads', analysisId, 'data.json');
                fileName = `${analysis.title || 'analysis'}-data.json`;
                if (!fs.existsSync(filePath)) {
                    await fs.promises.writeFile(filePath, analysis.resultData || '{}');
                }
                break;
        }
        if (!fs.existsSync(filePath)) {
            throw new common_1.NotFoundException('다운로드할 파일을 찾을 수 없습니다.');
        }
        await this.prisma.download.create({
            data: {
                userId,
                analysisId,
                fileType,
                filePath: path.relative(process.cwd(), filePath),
            },
        });
        return {
            downloadUrl: `/crawler/analysis/${analysisId}/file/${fileType}`,
            fileName,
            message: '다운로드 준비가 완료되었습니다.',
        };
    }
    async downloadFileStream(analysisId, fileType, req, res) {
        const userId = req.user.userId;
        const analysis = await this.crawlerService.getAnalysis(analysisId, userId);
        if (!analysis) {
            throw new common_1.NotFoundException('분석 결과를 찾을 수 없습니다.');
        }
        let filePath;
        let fileName;
        let contentType;
        switch (fileType) {
            case 'png':
                filePath = path.join(process.cwd(), 'uploads', analysisId, 'visualization.html');
                fileName = `${analysis.title || 'analysis'}-map.html`;
                contentType = 'text/html';
                break;
            case 'html':
                filePath = path.join(process.cwd(), 'uploads', analysisId, 'visualization.html');
                fileName = `${analysis.title || 'analysis'}-visualization.html`;
                contentType = 'text/html';
                break;
            case 'json':
                filePath = path.join(process.cwd(), 'uploads', analysisId, 'data.json');
                fileName = `${analysis.title || 'analysis'}-data.json`;
                contentType = 'application/json';
                if (!fs.existsSync(filePath)) {
                    await fs.promises.writeFile(filePath, analysis.resultData || '{}');
                }
                break;
            default:
                throw new common_1.BadRequestException('지원하지 않는 파일 형식입니다.');
        }
        if (!fs.existsSync(filePath)) {
            throw new common_1.NotFoundException('다운로드할 파일을 찾을 수 없습니다.');
        }
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.sendFile(filePath);
    }
    async getAnalysisHistory(req) {
        const userId = req.user.userId;
        const analyses = await this.crawlerService.getUserAnalyses(userId);
        return {
            analyses: analyses.map(analysis => ({
                id: analysis.id,
                url: analysis.url,
                title: analysis.title,
                status: analysis.status,
                pageCount: analysis.pageCount,
                createdAt: analysis.createdAt,
                updatedAt: analysis.updatedAt,
            })),
            total: analyses.length,
        };
    }
    async getAnalysisStatus(analysisId, req) {
        const userId = req.user.userId;
        const analysis = await this.crawlerService.getAnalysis(analysisId, userId);
        if (!analysis) {
            throw new common_1.NotFoundException('분석 결과를 찾을 수 없습니다.');
        }
        return {
            id: analysis.id,
            status: analysis.status,
            pageCount: analysis.pageCount,
            progress: analysis.status === 'completed' ? 100 :
                analysis.status === 'running' ? 50 : 0,
            message: this.getStatusMessage(analysis.status),
        };
    }
    getStatusMessage(status) {
        switch (status) {
            case 'pending':
                return '분석 대기 중입니다...';
            case 'running':
                return '웹사이트를 분석하고 있습니다...';
            case 'completed':
                return '분석이 완료되었습니다!';
            case 'failed':
                return '분석 중 오류가 발생했습니다.';
            default:
                return '알 수 없는 상태입니다.';
        }
    }
};
exports.CrawlerController = CrawlerController;
__decorate([
    (0, common_1.Post)('analyze'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "startAnalysis", null);
__decorate([
    (0, common_1.Get)('analysis/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getAnalysis", null);
__decorate([
    (0, common_1.Get)('analysis/:id/visualization'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Request)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getVisualization", null);
__decorate([
    (0, common_1.Get)('analysis/:id/screenshot/:filename'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Param)('filename')),
    __param(2, (0, common_1.Request)()),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getScreenshot", null);
__decorate([
    (0, common_1.Post)('analysis/:id/download'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "downloadFile", null);
__decorate([
    (0, common_1.Get)('analysis/:id/file/:fileType'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Param)('fileType')),
    __param(2, (0, common_1.Request)()),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "downloadFileStream", null);
__decorate([
    (0, common_1.Get)('history'),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getAnalysisHistory", null);
__decorate([
    (0, common_1.Get)('status/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], CrawlerController.prototype, "getAnalysisStatus", null);
exports.CrawlerController = CrawlerController = __decorate([
    (0, common_1.Controller)('crawler'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [crawler_service_1.CrawlerService,
        prisma_service_1.PrismaService])
], CrawlerController);
//# sourceMappingURL=crawler.controller.js.map