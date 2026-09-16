import { Module } from '@nestjs/common';
import { VeeamHttpService } from './http.service';

@Module({
  providers: [VeeamHttpService],
  exports: [VeeamHttpService],
})
export class VeeamHttpModule {}
