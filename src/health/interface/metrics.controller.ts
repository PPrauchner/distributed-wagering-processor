/**
 * `GET /metrics`: the service's metrics in the Prometheus text format, not
 * authenticated.
 *
 * @packageDocumentation
 */
import { Controller, Get, Res } from '@nestjs/common';
import { PrometheusMetrics } from '../infrastructure/prometheus-metrics.ts';

// The slice of the platform response this controller uses; keeps it off Express types.
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get()
  async scrape(@Res({ passthrough: true }) response: HttpResponse): Promise<string> {
    const { registry } = this.metrics;
    const text = await registry.metrics();
    response.setHeader('Content-Type', registry.contentType);
    return text;
  }
}
