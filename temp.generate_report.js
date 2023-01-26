import {ReportGenerator} from './report/generator/report-generator.js';
import results from './temp.report.json' assert { type: 'json' };
const html = ReportGenerator.generateReportHtml(results);

console.log(html);
