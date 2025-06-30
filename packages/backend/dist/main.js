"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
const common_1 = require("@nestjs/common");
const path_1 = require("path");
const prisma_service_1 = require("./prisma/prisma.service");
const bcrypt = require("bcrypt");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.enableCors({
        origin: '*',
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
        allowedHeaders: 'Content-Type, Accept, Authorization',
        credentials: true,
    });
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
    }));
    app.useStaticAssets((0, path_1.join)(__dirname, '..', 'uploads'), {
        prefix: '/uploads/',
    });
    app.useStaticAssets((0, path_1.join)(__dirname, '..', 'temp'), {
        prefix: '/temp/',
    });
    const prisma = app.get(prisma_service_1.PrismaService);
    try {
        const adminExists = await prisma.user.findUnique({
            where: { email: 'admin@local.com' }
        });
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash('Admin123!', 10);
            await prisma.user.create({
                data: {
                    email: 'admin@local.com',
                    password: hashedPassword,
                    plan: 'ENTERPRISE'
                }
            });
            console.log('✅ Admin account created: admin@local.com / Admin123!');
        }
        else {
            console.log('✅ Admin account already exists');
        }
    }
    catch (error) {
        console.error('❌ Failed to create admin account:', error);
    }
    const port = process.env.PORT || 3003;
    await app.listen(port);
    console.log(`🚀 Backend server running on http://localhost:${port}`);
}
bootstrap();
//# sourceMappingURL=main.js.map