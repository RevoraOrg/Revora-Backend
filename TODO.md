# TODO: Investor Statement PDF/UA Accessibility Tags

## Step 1: Create `src/services/statementDataProvider.ts`
- [x] Design data types for `StatementContent`
- [x] Implement `StatementDataProvider` class with data fetching logic
- [x] Export factory function

## Step 2: Create PDF/UA Document Builder in `statementPdfService.ts`
- [x] Implement PdfDocumentBuilder class
- [x] Build PDF/UA structure: MarkInfo, StructTreeRoot, RoleMap, ParentTree
- [x] Build content stream with marked-content operators (BDC/EMC)
- [x] Build XMP metadata for PDF/UA
- [x] Build content sections: title, period, investor info, holdings, transactions, distributions

## Step 3: Rewrite `renderStatementPdfBytes()` and update pipeline
- [x] Update function to accept StatementContent
- [x] Integrate PdfDocumentBuilder
- [x] Update makeStatementRenderFn to fetch data before rendering

## Step 4: Update Tests
- [x] Update statementPdfService tests for PDF/UA compliance
- [x] Update batch worker tests for new data flow

## Step 5: Update Documentation
- [x] Update docs/investor-statement-batch-pipeline.md

