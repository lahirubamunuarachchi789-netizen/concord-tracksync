// Concord TrackSync - Daily Output Report PDF API route.
//
// Accepts query parameters (departmentId, date, recordStatus, qcStatus), fetches
// the daily output matrix via the shared reportsService, builds a professional
// PDF (pdfkit) and returns it as a downloadable application/pdf response.

import { NextResponse } from 'next/server';
import { fetchDailyOutputReport } from '@/lib/reportsService';
import { buildDailyOutputPdf } from '@/lib/pdfReportService';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const departmentId = searchParams.get('departmentId') || '';
  const date = searchParams.get('date') || '';
  const recordStatus = searchParams.get('recordStatus') || 'ALL';
  const qcStatus = searchParams.get('qcStatus') || 'ALL';

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
      qcStatus,
    });
    const { buffer, fileName } = await buildDailyOutputPdf(matrix, {
      departmentId,
      date,
      recordStatus,
      qcStatus,
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
