#!/bin/bash

# Supabase 연결 정보 설정
export SUPABASE_URL=https://eqocdwowxzoikrdxxapn.supabase.co
export SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxb2Nkd293eHpvaWtyZHh4YXBuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE0Mjg0NzcsImV4cCI6MjA2NzAwNDQ3N30.y2UykhlUWatuZG0RO50s8nPRMhPNQ7PuZvZIM96pgEQ
export JWT_SECRET=my-super-secret-jwt-key
export PORT=3001
export DATABASE_URL="file:./dev.db"

# 개발 서버 실행
npm run start:dev 