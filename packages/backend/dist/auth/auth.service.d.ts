import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { SupabaseService } from '../supabase/supabase.service';
export declare class AuthService {
    private usersService;
    private jwtService;
    private supabaseService;
    constructor(usersService: UsersService, jwtService: JwtService, supabaseService: SupabaseService);
    signIn(email: string, pass: string): Promise<{
        access_token: string;
    }>;
    signUp(email: string, pass: string): Promise<{
        access_token: string;
        user: any;
    }>;
    signInWithSupabase(email: string, password: string): Promise<{
        access_token: string;
        user: any;
    }>;
    signOut(userId: string): Promise<{
        message: string;
    }>;
}
