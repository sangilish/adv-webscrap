import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private supabase: SupabaseClient;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    
    // Supabase가 설정되지 않은 경우 더미 클라이언트 생성
    if (!supabaseUrl || !supabaseKey || supabaseUrl === 'temp' || supabaseKey === 'temp') {
      console.warn('⚠️ Supabase not configured. Using dummy client.');
      this.supabase = null as any;
      return;
    }
    
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  getClient(): SupabaseClient {
    if (!this.supabase) {
      throw new Error('Supabase not configured');
    }
    return this.supabase;
  }

  isConfigured(): boolean {
    return this.supabase !== null;
  }

  // 유저별 데이터베이스 생성 (프로필 초기화)
  async createUserDatabase(userId: string, userEmail: string) {
    // Supabase에서는 Row Level Security (RLS)를 사용하여 유저별 데이터 분리
    // 별도의 데이터베이스 생성 대신 스키마 기반 분리 사용
    
    // 먼저 기존 프로필이 있는지 확인
    const { data: existingProfile } = await this.supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (existingProfile) {
      console.log('✅ 기존 프로필 발견, 생성 건너뛰기:', userId);
      return existingProfile;
    }

    // 유저 프로필 생성 (upsert 사용)
    const { data: profile, error: profileError } = await this.supabase
      .from('user_profiles')
      .upsert({
        id: userId,
        email: userEmail,
        plan: 'FREE',
        free_analysis_count: 0,
        subscription_type: 'free',
        last_reset_date: new Date().toISOString()
      })
      .select()
      .single();

    if (profileError) {
      console.warn('⚠️ 프로필 생성 실패 (트리거가 이미 생성했을 수 있음):', profileError.message);
      
      // 트리거가 이미 생성했을 가능성이 있으므로 다시 조회
      const { data: retryProfile } = await this.supabase
        .from('user_profiles')
        .select('*')
        .eq('id', userId)
        .single();
      
      if (retryProfile) {
        console.log('✅ 트리거로 생성된 프로필 발견:', userId);
        return retryProfile;
      }
      
      throw new Error(`프로필 생성 실패: ${profileError.message}`);
    }

    console.log('✅ 새 프로필 생성 성공:', userId);
    return profile;
  }

  // 유저별 분석 데이터 저장
  async saveAnalysis(userId: string, analysisData: any) {
    const { data, error } = await this.supabase
      .from('analyses')
      .insert({
        user_id: userId,
        url: analysisData.url,
        title: analysisData.title,
        status: analysisData.status || 'pending',
        progress: analysisData.progress || 0,
        page_count: analysisData.pageCount || 0,
        result_data: analysisData.resultData ? JSON.stringify(analysisData.resultData) : null,
        screenshot_path: analysisData.screenshotPath,
        html_path: analysisData.htmlPath
      })
      .select()
      .single();

    if (error) {
      throw new Error(`분석 저장 실패: ${error.message}`);
    }

    return data;
  }

  // 분석 데이터 업데이트
  async updateAnalysis(analysisId: string, updates: any) {
    const { data, error } = await this.supabase
      .from('analyses')
      .update({
        ...updates,
        result_data: updates.resultData ? JSON.stringify(updates.resultData) : updates.result_data,
        updated_at: new Date().toISOString()
      })
      .eq('id', analysisId)
      .select()
      .single();

    if (error) {
      throw new Error(`분석 업데이트 실패: ${error.message}`);
    }

    return data;
  }

  // 유저별 데이터 조회
  async getUserAnalyses(userId: string) {
    const { data, error } = await this.supabase
      .from('analyses')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`분석 조회 실패: ${error.message}`);
    }

    return data;
  }

  // 특정 분석 조회
  async getAnalysis(analysisId: string, userId: string) {
    const { data, error } = await this.supabase
      .from('analyses')
      .select('*')
      .eq('id', analysisId)
      .eq('user_id', userId)
      .single();

    if (error) {
      throw new Error(`분석 조회 실패: ${error.message}`);
    }

    return data;
  }

  // 유저 프로필 조회
  async getUserProfile(userId: string) {
    const { data, error } = await this.supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      throw new Error(`프로필 조회 실패: ${error.message}`);
    }

    return data;
  }

  // 유저 프로필 업데이트
  async updateUserProfile(userId: string, updates: any) {
    const { data, error } = await this.supabase
      .from('user_profiles')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      throw new Error(`프로필 업데이트 실패: ${error.message}`);
    }

    return data;
  }

  // 결제 정보 저장
  async savePayment(userId: string, paymentData: any) {
    const { data, error } = await this.supabase
      .from('payments')
      .insert({
        user_id: userId,
        stripe_session_id: paymentData.stripeSessionId,
        amount: paymentData.amount,
        currency: paymentData.currency || 'KRW',
        status: paymentData.status || 'pending',
        type: paymentData.type,
        description: paymentData.description
      })
      .select()
      .single();

    if (error) {
      throw new Error(`결제 정보 저장 실패: ${error.message}`);
    }

    return data;
  }

  // 다운로드 기록 저장
  async saveDownload(userId: string, analysisId: string, downloadData: any) {
    const { data, error } = await this.supabase
      .from('downloads')
      .insert({
        user_id: userId,
        analysis_id: analysisId,
        file_type: downloadData.fileType,
        file_path: downloadData.filePath
      })
      .select()
      .single();

    if (error) {
      throw new Error(`다운로드 기록 저장 실패: ${error.message}`);
    }

    return data;
  }

  // 유저 통계 조회
  async getUserStats(userId: string) {
    const [analysesResult, downloadsResult] = await Promise.all([
      this.supabase
        .from('analyses')
        .select('id, status, created_at')
        .eq('user_id', userId),
      this.supabase
        .from('downloads')
        .select('id, created_at')
        .eq('user_id', userId)
    ]);

    if (analysesResult.error) {
      throw new Error(`분석 통계 조회 실패: ${analysesResult.error.message}`);
    }

    if (downloadsResult.error) {
      throw new Error(`다운로드 통계 조회 실패: ${downloadsResult.error.message}`);
    }

    const totalAnalyses = analysesResult.data?.length || 0;
    const completedAnalyses = analysesResult.data?.filter(a => a.status === 'completed').length || 0;
    const totalDownloads = downloadsResult.data?.length || 0;

    return {
      totalAnalyses,
      completedAnalyses,
      totalDownloads,
      analyses: analysesResult.data,
      downloads: downloadsResult.data
    };
  }
} 