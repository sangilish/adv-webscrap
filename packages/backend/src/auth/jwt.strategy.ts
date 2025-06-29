import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private usersService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'your-default-secret',
    });
  }

  async validate(payload: { sub: number; email: string }) {
    const user = await this.usersService.findOne({ id: payload.sub });
    if (!user) {
      throw new UnauthorizedException();
    }
    // The user object will be attached to the request object
    return { userId: payload.sub, email: payload.email };
  }
} 