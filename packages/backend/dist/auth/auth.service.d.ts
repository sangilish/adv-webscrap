import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
export declare class AuthService {
    private usersService;
    private jwtService;
    constructor(usersService: UsersService, jwtService: JwtService);
    signIn(email: string, pass: string): Promise<{
        access_token: string;
    }>;
    signUp(email: string, pass: string): Promise<{
        access_token: string;
    }>;
}
