/**
 * `GET /health/live` — the process answers — and `GET /health/ready` — the
 * database and the queues answer, 200 or 503. Neither is authenticated.
 *
 * @packageDocumentation
 */
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { CheckReadiness, type ReadinessReport } from '../application/check-readiness.ts';

// The slice of the platform response this controller uses; keeps it off Express types.
interface HttpResponse {
  status(code: number): unknown;
}

@Controller('health')
export class HealthController {
  constructor(private readonly checkReadiness: CheckReadiness) {}

  @Get('live')
  live(): { status: 'up' } {
    return { status: 'up' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse): Promise<ReadinessReport> {
    const report = await this.checkReadiness.execute();
    response.status(report.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
