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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const users_service_1 = require("../users/users.service");
const jwt_1 = require("@nestjs/jwt");
const supabase_service_1 = require("../supabase/supabase.service");
const bcrypt = require("bcrypt");
let AuthService = class AuthService {
    usersService;
    jwtService;
    supabaseService;
    constructor(usersService, jwtService, supabaseService) {
        this.usersService = usersService;
        this.jwtService = jwtService;
        this.supabaseService = supabaseService;
    }
    async signIn(email, pass) {
        const user = await this.usersService.findOne({ email });
        if (!user) {
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        const isPasswordMatching = await bcrypt.compare(pass, user.password);
        if (!isPasswordMatching) {
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        const payload = { sub: user.id, email: user.email };
        return {
            access_token: await this.jwtService.signAsync(payload),
        };
    }
    async signUp(email, pass) {
        const existingUser = await this.usersService.findOne({ email });
        if (existingUser) {
            throw new common_1.ConflictException('Email already exists');
        }
        const hashedPassword = await bcrypt.hash(pass, 10);
        const user = await this.usersService.createUser({
            email,
            password: hashedPassword,
        });
        let supabaseUserId = null;
        let supabaseSession = null;
        if (this.supabaseService.isConfigured()) {
            try {
                console.log('🔄 Supabase 회원가입 시도:', email);
                const supabase = this.supabaseService.getClient();
                const { data: authData, error: authError } = await supabase.auth.signUp({
                    email,
                    password: pass,
                });
                console.log('📊 Supabase Auth 응답:', {
                    user: authData?.user ? 'User 생성됨' : 'User 없음',
                    session: authData?.session ? 'Session 있음' : 'Session 없음',
                    error: authError ? authError.message : '오류 없음'
                });
                if (!authError && authData.user) {
                    supabaseUserId = authData.user.id;
                    supabaseSession = authData.session;
                    console.log('✅ Supabase 유저 생성 성공:', supabaseUserId);
                    await this.supabaseService.createUserDatabase(authData.user.id, email);
                }
                else if (authError) {
                    console.error('❌ Supabase Auth 오류:', authError);
                }
            }
            catch (error) {
                console.error('🚨 Supabase 회원가입 예외:', error);
            }
        }
        else {
            console.log('⚠️ Supabase가 설정되지 않음');
        }
        const payload = {
            sub: user.id,
            email: user.email
        };
        if (supabaseUserId) {
            payload.supabaseId = supabaseUserId;
        }
        const responseUser = {
            id: user.id,
            email: user.email
        };
        if (supabaseUserId) {
            responseUser.supabaseId = supabaseUserId;
        }
        if (supabaseSession) {
            responseUser.session = supabaseSession;
        }
        return {
            access_token: await this.jwtService.signAsync(payload),
            user: responseUser
        };
    }
    async signInWithSupabase(email, password) {
        const supabase = this.supabaseService.getClient();
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });
        if (error) {
            throw new common_1.UnauthorizedException('로그인 실패');
        }
        const localUser = await this.usersService.findOne({ email });
        const payload = {
            sub: localUser?.id || data.user.id,
            email: data.user.email,
            supabaseId: data.user.id
        };
        return {
            access_token: await this.jwtService.signAsync(payload),
            user: {
                id: localUser?.id || data.user.id,
                email: data.user.email,
                supabaseId: data.user.id,
                session: data.session
            }
        };
    }
    async signOut(userId) {
        const supabase = this.supabaseService.getClient();
        const { error } = await supabase.auth.signOut();
        if (error) {
            throw new Error(`로그아웃 실패: ${error.message}`);
        }
        return { message: '로그아웃 성공' };
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [users_service_1.UsersService,
        jwt_1.JwtService,
        supabase_service_1.SupabaseService])
], AuthService);
//# sourceMappingURL=auth.service.js.map