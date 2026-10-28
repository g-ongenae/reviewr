import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import type { Document, DocumentSummary, Revision, RevisionSummary } from '@reviewr/shared';
import { DocumentsService } from './documents.service.js';
import { CreateDocumentDto } from './dto/create-document.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';

/**
 * REST resource for the user's documents and their revision history.
 */
@Controller('documents')
export class DocumentsController {
  /**
   * @param documentsService - Documents business logic
   */
  constructor(private readonly documentsService: DocumentsService) {}

  /**
   * GET /documents
   */
  @Get()
  public async list(): Promise<DocumentSummary[]> {
    return this.documentsService.list();
  }

  /**
   * POST /documents
   */
  @Post()
  public async create(@Body() body: CreateDocumentDto): Promise<Document> {
    return this.documentsService.create(body);
  }

  /**
   * GET /documents/:id
   */
  @Get(':id')
  public async get(@Param('id', ParseUUIDPipe) id: string): Promise<Document> {
    return this.documentsService.get(id);
  }

  /**
   * PUT /documents/:id
   */
  @Put(':id')
  public async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDocumentDto): Promise<Document> {
    return this.documentsService.update(id, body);
  }

  /**
   * DELETE /documents/:id
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.documentsService.delete(id);
  }

  /**
   * GET /documents/:id/revisions
   */
  @Get(':id/revisions')
  public async listRevisions(@Param('id', ParseUUIDPipe) id: string): Promise<RevisionSummary[]> {
    return this.documentsService.listRevisions(id);
  }

  /**
   * GET /documents/:id/revisions/:revision
   */
  @Get(':id/revisions/:revision')
  public async getRevision(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revision', ParseIntPipe) revisionNumber: number,
  ): Promise<Revision> {
    return this.documentsService.getRevision(id, revisionNumber);
  }
}
