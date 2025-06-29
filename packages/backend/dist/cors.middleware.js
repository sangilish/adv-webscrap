"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CorsMiddleware = void 0;
const common_1 = require("@nestjs/common");
let CorsMiddleware = class CorsMiddleware {
    use(req, res, next) {
        console.log('🔥 CORS Middleware called for:', req.method, req.url, 'Origin:', req.headers.origin);
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
        console.log('🔥 CORS headers set:', {
            'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin'),
            'Access-Control-Allow-Credentials': res.getHeader('Access-Control-Allow-Credentials'),
        });
        if (req.method === 'OPTIONS') {
            console.log('🔥 Handling OPTIONS preflight request');
            res.status(204).end();
            return;
        }
        next();
    }
};
exports.CorsMiddleware = CorsMiddleware;
exports.CorsMiddleware = CorsMiddleware = __decorate([
    (0, common_1.Injectable)()
], CorsMiddleware);
//# sourceMappingURL=cors.middleware.js.map