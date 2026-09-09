// Concord TrackSync - Daily Output Report PDF API route.
//
// Accepts query parameters (departmentId, date, recordStatus, qcStatus,
// qcStatuses), fetches the daily output matrix via the shared reportsService,
// builds a professional PDF (pdfkit) and returns it as a downloadable
// application/pdf response. `qcStatuses` carries the multi-select QC status
// list (comma-separated); the legacy single `qcStatus` is still accepted.

import { NextResponse } from 'next/server';
// Server-only imports: reportsService (DB access + aggregation) and the
// pdfkit-based PDF builder must run in the Node.js runtime on the server.
import {
  fetchDailyOutputReport,
  normalizeQcStatuses,
} from '@/lib/reportsService';
import { buildDailyOutputPdf } from '@/lib/pdfReportService';

export const dynamic = 'force-dynamic';
// Pin the Node.js runtime: pdfkit depends on Node built-ins (fs, path) and
// the report aggregation hits the database - neither can run on the edge.
export const runtime = 'nodejs';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const departmentId = searchParams.get('departmentId') || '';
  const date = searchParams.get('date') || '';
  const recordStatus = searchParams.get('recordStatus') || 'ALL';
  const qcStatus = searchParams.get('qcStatus') || 'ALL';
  // Multi-select: a comma-separated QC status list, e.g. qcStatuses=Forward,Return.
  const qcStatusesParam = (searchParams.get('qcStatuses') || '')
    .split(',')
    .map((status) => status.trim())
    .filter(Boolean);
  // Resolve to the concrete status list ([] = ALL) shared by the queries,
  // the aggregation and the PDF banner.
  const qcStatuses = normalizeQcStatuses({ qcStatus, qcStatuses: qcStatusesParam });
  const qcLabel = qcStatuses.length > 0 ? qcStatuses.join(', ') : 'ALL';

  if (!date) {
    return NextResponse.json(
      { error: 'A date (YYYY-MM-DD, SLST) is required.' },
      { status: 400 }
    );
  }

  try {
    const matrix = await fetchDailyOutputReport({
      departmentId,
      date,
      recordStatus,
      qcStatuses,
    });
    const { buffer, fileName } = await buildDailyOutputPdf(matrix, {
      departmentId,
      date,
      recordStatus,
      qcStatuses,
      qcStatus: qcLabel,
    });

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(buffer.length),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || 'Failed to generate PDF.' },
      { status: 500 }
    );
  }
}
