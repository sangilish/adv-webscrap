import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { SupabaseService } from '../supabase/supabase.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private supabaseService: SupabaseService,
  ) {}

  async signIn(email: string, pass: string): Promise<{ access_token: string }> {
    const user = await this.usersService.findOne({ email });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordMatching = await bcrypt.compare(pass, user.password);
    if (!isPasswordMatching) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: user.id, email: user.email };
    return {
      access_token: await this.jwtService.signAsync(payload),
    };
  }

  async signUp(email: string, pass: string): Promise<{ access_token: string; user: any }> {
    // 기존 Prisma 데이터베이스에서 중복 확인
    const existingUser = await this.usersService.findOne({ email });
    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    // 기존 Prisma 데이터베이스에 유저 생성
    const hashedPassword = await bcrypt.hash(pass, 10);
    const user = await this.usersService.createUser({
      email,
      password: hashedPassword,
    });

    let supabaseUserId: string | null = null;
    let supabaseSession: any = null;

    // Supabase가 설정된 경우에만 Supabase Auth 사용
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
          
          // Supabase에 유저 프로필 생성
          await this.supabaseService.createUserDatabase(authData.user.id, email);
        } else if (authError) {
          console.error('❌ Supabase Auth 오류:', authError);
        }
      } catch (error) {
        console.error('🚨 Supabase 회원가입 예외:', error);
      }
    } else {
      console.log('⚠️ Supabase가 설정되지 않음');
    }

    const payload: any = { 
      sub: user.id, 
      email: user.email
    };
    
    if (supabaseUserId) {
      payload.supabaseId = supabaseUserId;
    }

    const responseUser: any = {
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

  async signInWithSupabase(email: string, password: string): Promise<{ access_token: string; user: any }> {
    const supabase = this.supabaseService.getClient();
    
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      throw new UnauthorizedException('로그인 실패');
    }

    // 기존 Prisma 유저 정보도 확인
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

  async signOut(userId: string): Promise<{ message: string }> {
    const supabase = this.supabaseService.getClient();
    
    const { error } = await supabase.auth.signOut();
    
    if (error) {
      throw new Error(`로그아웃 실패: ${error.message}`);
    }

    return { message: '로그아웃 성공' };
  }
}
