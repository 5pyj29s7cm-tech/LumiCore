declare module 'exceljs/dist/exceljs.min.js' {
  const ExcelJS: {
    Workbook: new () => any;
  };
  export default ExcelJS;
}
