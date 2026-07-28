# TODO: Investor Statement PDF/UA Accessibility Tags

## Step 1: Create `src/services/statementDataProvider.ts`
- [x] Design data types for `StatementContent`
- [x] Implement `StatementDataProvider` class with data fetching logic
- [x] Export factory function

## Step 2: Create PDF/UA Document Builder in `statementPdfService.ts`
- [ ] Implement PdfDocumentBuilder class
- [ ] Build PDF/UA structure: MarkInfo, StructTreeRoot, RoleMap, ParentTree
- [ ] Build content stream with marked-content operators (BDC/EMC)
- [ ] Build XMP metadata for PDF/UA
- [ ] Build content sections: title, period, investor info, holdings, transactions, distributions

## Step 3: Rewrite `renderStatementPdfBytes()` and update pipeline
- [ ] Update function to accept StatementContent
- [ ] Integrate PdfDocumentBuilder
- [ ] Update makeStatementRenderFn to fetch data before rendering

## Step 4: Update Tests
- [ ] Update statementPdfService tests for PDF/UA compliance
- [ ] Update batch worker tests for new data flow

## Step 5: Update Documentation
- [ ] Update docs/investor-statement-batch-pipeline.md

