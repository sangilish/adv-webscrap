# Supabase 설정 및 마이그레이션 가이드

## 1. Supabase 프로젝트 생성

1. [Supabase 웹사이트](https://supabase.com)에 접속
2. 새 프로젝트 생성
3. 프로젝트 설정에서 다음 정보 확인:
   - Project URL
   - Anon Key
   - Service Role Key

## 2. 환경 변수 설정

`.env` 파일을 생성하고 다음 내용을 추가하세요:

```bash
# Supabase 설정
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# JWT 설정
JWT_SECRET=your-super-secret-jwt-key-here

# 앱 설정
PORT=3001
```

## 3. 데이터베이스 스키마 설정

1. Supabase 대시보드에서 SQL Editor로 이동
2. `supabase-schema.sql` 파일의 내용을 복사하여 실행
3. 모든 테이블과 RLS 정책이 생성되었는지 확인

## 4. 주요 기능

### 유저별 데이터 분리
- **Row Level Security (RLS)**: 각 유저는 자신의 데이터만 접근 가능
- **자동 프로필 생성**: 새 유저 가입 시 자동으로 프로필 테이블 생성
- **실시간 동기화**: Supabase의 실시간 기능 활용 가능

### 인증 시스템
- **Supabase Auth**: 강력한 인증 시스템
- **JWT 토큰**: 기존 시스템과 호환성 유지
- **이중 저장**: Prisma와 Supabase 동시 사용으로 안정성 확보

### 데이터 구조
```
user_profiles: 유저 프로필 및 구독 정보
analyses: 웹사이트 분석 데이터
payments: 결제 정보
downloads: 다운로드 기록
```

## 5. API 엔드포인트

### 인증
- `POST /auth/signup`: 회원가입 (Supabase + Prisma)
- `POST /auth/login`: 기존 로그인 (Prisma)
- `POST /auth/login/supabase`: Supabase 로그인
- `POST /auth/logout`: 로그아웃

### 분석
- 크롤링 시 자동으로 Supabase에 데이터 저장
- 유저별 데이터 자동 분리
- 실시간 진행률 업데이트 가능

## 6. 마이그레이션 체크리스트

- [x] Supabase 클라이언트 설치
- [x] SupabaseService 생성
- [x] SupabaseModule 생성
- [x] AuthService Supabase 연동
- [x] CrawlerService Supabase 연동
- [x] 데이터베이스 스키마 생성
- [ ] 환경 변수 설정
- [ ] Supabase 프로젝트 생성
- [ ] 스키마 SQL 실행

## 7. 테스트 방법

### 1. 회원가입 테스트
```bash
curl -X POST http://localhost:3001/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "password123"}'
```

### 2. Supabase 로그인 테스트
```bash
curl -X POST http://localhost:3001/auth/login/supabase \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "password123"}'
```

### 3. 데이터 확인
- Supabase 대시보드에서 `user_profiles` 테이블 확인
- 새 유저가 자동으로 생성되었는지 확인

## 8. 장점

1. **확장성**: PostgreSQL 기반으로 대용량 데이터 처리
2. **보안**: RLS로 유저별 데이터 완전 분리
3. **실시간**: 실시간 데이터 동기화 가능
4. **관리**: Supabase 대시보드로 쉬운 데이터 관리
5. **백업**: 자동 백업 및 복구 기능
6. **호환성**: 기존 Prisma 시스템과 병행 사용

## 9. 주의사항

1. **환경 변수**: 실제 운영 환경에서는 보안 키를 안전하게 관리
2. **RLS 정책**: 데이터 접근 권한을 정확히 설정
3. **인덱스**: 대용량 데이터 처리를 위한 적절한 인덱스 생성
4. **모니터링**: Supabase 대시보드에서 성능 모니터링

## 10. 다음 단계

1. 프론트엔드에서 Supabase 클라이언트 연동
2. 실시간 기능 활용 (진행률 표시 등)
3. 파일 업로드를 위한 Supabase Storage 활용
4. 고급 쿼리 및 함수 활용

이제 Supabase를 활용한 유저별 데이터베이스 시스템이 준비되었습니다! 