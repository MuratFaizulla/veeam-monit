import { Module } from '@nestjs/common';
import { VeeamHttpModule } from '../veeam/veeam-http.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { SessionStore } from './session.store';

@Module({
  imports: [VeeamHttpModule],
  controllers: [AuthController],
  providers: [AuthService, SessionStore, AuthGuard],
  exports: [AuthService, SessionStore, AuthGuard],
})
export class AuthModule {}
