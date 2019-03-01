import { Component } from "@prague/app-component";
import {
    EvalFormulaPaused,
    FailureReason,
    IllFormedFormula,
    NotFormulaString,
    NotImplemented,
    ReadOper,
    Result,
    ResultKind,
    UnboxedOper,
    Workbook,
} from "@prague/client-ui/ext/calc";
import { MapExtension, registerDefaultValueType  } from "@prague/map";
import { CounterValueType } from "@prague/map";
import {
    ICombiningOp,
    IntervalType,
    LocalClientId,
    LocalReference,
    MergeTree,
    PropertySet,
    UniversalSequenceNumber,
} from "@prague/merge-tree";
import {
    SharedIntervalCollectionValueType,
    SharedNumberSequence,
    SharedNumberSequenceExtension,
    SharedStringIntervalCollectionValueType,
} from "@prague/sequence";
import { CellInterval } from "./cellinterval";
import { createComponentType } from "./pkg";
import { TableSlice } from "./slice";
import { ITable } from "./table";

export const loadCellTextSym = Symbol("TableDocument.loadCellText");
export const storeCellTextSym = Symbol("TableDocument.storeCellText");

type EvaluationResult = Result<ReadOper, FailureReason | NotImplemented | NotFormulaString | IllFormedFormula> | EvalFormulaPaused;

class WorkbookAdapter extends Workbook {
    // TODO: Our base class has a bug that calls 'storeCellText' during init(), overwriting
    //       incoming shared data.
    private isInitializing = true;

    constructor(private readonly doc: TableDocument) {
        // Note: The row/col provided here is only used by the '.init()' method.
        super(doc.numRows, doc.numCols);

        this.isInitializing = true;
        const init = [];
        for (let row = 0; row < doc.numRows; row++) {
            const rowArray: UnboxedOper[] = [];
            init.push(rowArray);
            for (let col = 0; col < doc.numCols; col++) {
                rowArray.push(this.doc[loadCellTextSym](row, col));
            }
        }

        this.init(init);
        this.isInitializing = false;
    }

    protected loadCellText(row: number, col: number): string {
        return `${this.doc[loadCellTextSym](row, col)}`;
    }

    protected storeCellText(row: number, col: number, value: UnboxedOper) {
        if (this.isInitializing) {
            return;
        }

        this.doc[storeCellTextSym](row, col, value);
    }
}

export class TableDocument extends Component implements ITable {
    private get length()     { return this.mergeTree.getLength(UniversalSequenceNumber, LocalClientId); }
    public  get numCols()    { return Math.min(this.root.get("stride").value, this.length); }
    public  get numRows()    { return Math.floor(this.length / this.numCols); }

    private get matrix()        { return this.maybeMatrix!; }
    private get mergeTree()     { return this.maybeMergeTree!; }
    private get workbook()      { return this.maybeWorkbook!; }
    public static readonly type = createComponentType(TableDocument);

    private maybeRows?: SharedNumberSequence;
    private maybeCols?: SharedNumberSequence;
    private maybeMatrix?: SharedNumberSequence;
    private maybeMergeTree?: MergeTree;
    private maybeWorkbook?: WorkbookAdapter;

    constructor() {
        super([
            [MapExtension.Type, new MapExtension()],
            [SharedNumberSequenceExtension.Type, new SharedNumberSequenceExtension()],
        ]);

        registerDefaultValueType(new CounterValueType());
        registerDefaultValueType(new SharedStringIntervalCollectionValueType());
        registerDefaultValueType(new SharedIntervalCollectionValueType());
    }

    public evaluateCell(row: number, col: number) {
        return this.parseResult(this.workbook.evaluateCell(row, col));
    }

    public evaluateFormula(formula: string) {
        return this.parseResult(this.workbook.evaluateFormulaText(formula, 0, 0));
    }

    public getCellText(row: number, col: number) {
        return this[loadCellTextSym](row, col);
    }

    public setCellText(row: number, col: number, value: UnboxedOper) {
        this.workbook.setCellText(row, col, value);
    }

    public async getRange(label: string) {
        const intervals = this.matrix.getSharedIntervalCollection(label);
        const interval = (await intervals.getView()).nextInterval(0);
        return new CellInterval(interval, this.localRefToRowCol);
    }

    public async createSlice(sliceId: string, name: string, minRow: number, minCol: number, maxRow: number, maxCol: number): Promise<ITable> {
        await this.host.createAndAttachComponent(sliceId, TableSlice.type);
        return await this.host.openComponent<TableSlice>(
            sliceId, true, [
                ["config", Promise.resolve({ docId: this.host.id, name, minRow, minCol, maxRow, maxCol })],
            ]);
    }

    public annotateRows(startRow: number, endRow: number, properties: PropertySet, op?: ICombiningOp) {
        this.maybeRows.annotateRange(properties, startRow, endRow, op);
    }

    public getRowProperties(row: number): PropertySet {
        const {segment} = this.maybeRows.client.mergeTree.getContainingSegment(row, UniversalSequenceNumber, LocalClientId);
        return segment.properties;
    }

    public annotateCols(startCol: number, endCol: number, properties: PropertySet, op?: ICombiningOp) {
        this.maybeCols.annotateRange(properties, startCol, endCol, op);
    }

    public getColProperties(col: number): PropertySet {
        const {segment} = this.maybeCols.client.mergeTree.getContainingSegment(col, UniversalSequenceNumber, LocalClientId);
        return segment.properties;
    }

    /** For internal use by TableSlice: Please do not use. */
    public createInterval(label: string, minRow: number, minCol: number, maxRow: number, maxCol: number) {
        const start = this.rowColToPosition(minRow, minCol);
        const end = this.rowColToPosition(maxRow, maxCol);
        const intervals = this.matrix.getSharedIntervalCollection(label);
        intervals.add(start, end, IntervalType.Simple);
    }

    protected async create() {
        const numRows = 7;
        const numCols = 8;

        const rows = this.runtime.createChannel("rows", SharedNumberSequenceExtension.Type) as SharedNumberSequence;
        rows.insert(0, new Array(numRows).fill(0));
        this.root.set("rows", rows);

        const cols = this.runtime.createChannel("cols", SharedNumberSequenceExtension.Type) as SharedNumberSequence;
        cols.insert(0, new Array(numCols).fill(0));
        this.root.set("cols", cols);

        const matrix = this.runtime.createChannel("matrix", SharedNumberSequenceExtension.Type) as SharedNumberSequence;
        matrix.insert(0, new Array(numRows * numCols).fill(+Infinity));
        this.root.set("stride", numCols, CounterValueType.Name);
        this.root.set("matrix", matrix);
    }

    protected async opened() {
        this.maybeMatrix = await this.root.wait("matrix") as SharedNumberSequence;
        this.maybeRows = await this.root.wait("rows") as SharedNumberSequence;
        this.maybeCols = await this.root.wait("cols") as SharedNumberSequence;
        await this.connected;

        const client = this.matrix.client;
        this.maybeMergeTree = client.mergeTree;
        this.matrix.on("op", (op, local) => {
            if (!local) {
                for (let row = 0; row < this.numRows; row++) {
                    for (let col = 0; col < this.numCols; col++) {
                        this.workbook.setCellText(row, col, this.getCellText(row, col), /* isExternal: */ true);
                    }
                }
            }

            this.emit("op", op, local);
        });

        this.maybeWorkbook = new WorkbookAdapter(this);
    }

    private [loadCellTextSym](row: number, col: number): UnboxedOper {
        const position = this.rowColToPosition(row, col);
        const asNumber = this.matrix.getItems(position, position + 1)[0];

        switch (asNumber) {
            case +Infinity: return "";
            default:
                if (isNaN(asNumber)) {
                    return this.matrix.getPropertiesAtPosition(position).value;
                } else {
                    return asNumber;
                }
        }
    }

    private [storeCellTextSym](row: number, col: number, value: UnboxedOper) {
        const position = this.rowColToPosition(row, col);
        if (value === "") {
            this.setPosition(position, +Infinity);          // Encode empty string as +Infinity
            this.annotatePosition(position, undefined);
        } else if (typeof value === "number" && isFinite(value)) {
            this.setPosition(position, value);              // Encode finite number as numbers
            this.annotatePosition(position, undefined);
        } else {
            this.setPosition(position, NaN);                // Store other values/types as annotations
            this.annotatePosition(position, value);
        }
    }

    private localRefToPosition(localRef: LocalReference) {
        return localRef.toPosition(this.mergeTree, UniversalSequenceNumber, LocalClientId);
    }

    private readonly localRefToRowCol = (localRef: LocalReference) => this.positionToRowCol(this.localRefToPosition(localRef));

    private parseResult(result: EvaluationResult): string | number | boolean {
        switch (result.kind) {
            case ResultKind.Success: {
                const value = result.value;
                switch (typeof value) {
                    case "string":
                    case "number":
                    case "boolean":
                        return value;

                    default:
                        return this.workbook.serialiseValue(value);
                }
            }
            default:
                return result.reason.toString();
        }
    }

    private rowColToPosition(row: number, col: number) {
        return row * this.numCols + col;
    }

    private positionToRowCol(position: number) {
        const row = Math.floor(position / this.numCols);
        const col = position - (row * this.numCols);
        return {row, col};
    }

    private setPosition(position: number, value: number) {
        this.matrix.remove(position, position + 1);
        this.matrix.insert(position, [ value ]);
    }

    private annotatePosition(position: number, value: UnboxedOper) {
        this.matrix.annotateRange({ value }, position, position + 1);
    }
}
