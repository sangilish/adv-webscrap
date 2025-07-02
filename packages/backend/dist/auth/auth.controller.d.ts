import { AuthService } from './auth.service';
export declare class AuthController {
    private authService;
    constructor(authService: AuthService);
    signIn(signInDto: Record<string, any>): Promise<{
        access_token: string;
    }>;
    signInWithSupabase(signInDto: Record<string, any>): Promise<{
        access_token: string;
        user: any;
    }>;
    signUp(signUpDto: Record<string, any>): Promise<{
        access_token: string;
        user: any;
    }>;
    signOut(req: any): Promise<{
        message: string;
    }>;
    getProfile(req: any): any;
}
