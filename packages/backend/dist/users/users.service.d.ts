import { PrismaService } from '../prisma/prisma.service';
import { User, Prisma } from '../../generated/prisma';
export declare class UsersService {
    private prisma;
    constructor(prisma: PrismaService);
    findOne(userWhereUniqueInput: Prisma.UserWhereUniqueInput): Promise<User | null>;
    createUser(data: Prisma.UserCreateInput): Promise<User>;
}
