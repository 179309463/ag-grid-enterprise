import {
    Utils,
    Bean,
    IRowNodeStage,
    Autowired,
    GridOptionsWrapper,
    ColumnController,
    ValueService,
    RowNode,
    PivotService,
    Column,
    IAggFunction
} from "ag-grid/main";

@Bean('aggregationStage')
export class AggregationStage implements IRowNodeStage {

    @Autowired('gridOptionsWrapper') private gridOptionsWrapper: GridOptionsWrapper;
    @Autowired('columnController') private columnController: ColumnController;
    @Autowired('valueService') private valueService: ValueService;
    @Autowired('pivotService') private pivotService: PivotService;

    private aggFunctionService = new AggFunctionService();

    // it's possible to recompute the aggregate without doing the other parts
    // + gridApi.recomputeAggregates()
    public execute(rootNode: RowNode): any {

        // we don't do aggregation if user provided the groups
        var rowsAlreadyGrouped = Utils.exists(this.gridOptionsWrapper.getNodeChildDetailsFunc());
        if (rowsAlreadyGrouped) {
            return;
        }

        var valueColumns = this.columnController.getValueColumns();
        var pivotColumns = this.columnController.getPivotColumns();

        this.recursivelyCreateAggData(rootNode, valueColumns, pivotColumns);
    }

    private recursivelyCreateAggData(rowNode: RowNode, valueColumns: Column[], pivotColumns: Column[]) {

        // aggregate all children first, as we use the result in this nodes calculations
        rowNode.childrenAfterFilter.forEach( child => {
            if (child.group) {
                this.recursivelyCreateAggData(child, valueColumns, pivotColumns);
            }
        });

        this.aggregateRowNode(rowNode, valueColumns, pivotColumns);
    }

    private aggregateRowNode(rowNode: RowNode, valueColumns: Column[], pivotColumns: Column[]): void {
        
        var valueColumnsMissing = valueColumns.length === 0;
        var pivotColumnsMissing = pivotColumns.length === 0;
        var userProvidedGroupRowAggNodes = this.gridOptionsWrapper.getGroupRowAggNodesFunc();

        var aggResult: any;
        if (userProvidedGroupRowAggNodes) {
            aggResult = userProvidedGroupRowAggNodes(rowNode.childrenAfterFilter);
        } else if (valueColumnsMissing) {
            aggResult = null;
        } else if (pivotColumnsMissing) {
            aggResult = this.aggregateRowNodeUsingValuesOnly(rowNode, valueColumns);
        } else {
            aggResult = this.aggregateRowNodeUsingValuesAndPivot(rowNode);
        }

        rowNode.data = aggResult;

        // if we are grouping, then it's possible there is a sibling footer
        // to the group, so update the data here also if there is one
        if (rowNode.sibling) {
            rowNode.sibling.data = aggResult;
        }
    }

    private aggregateRowNodeUsingValuesAndPivot(rowNode: RowNode): any {
        var result: any = {};
        var pivotColumnDefs = this.pivotService.getPivotColumnDefs();

        pivotColumnDefs.forEach( pivotColumnDef => {

            var values: any[];
            var valueColumn: Column = (<any>pivotColumnDef).valueColumn;

            if (rowNode.leafGroup) {
                // lowest level group, get the values from the mapped set
                var keys = (<any>pivotColumnDef).keys;
                values = this.getValuesFromMappedSet(rowNode.childrenMapped, keys, valueColumn);
            } else {
                // value columns and pivot columns, non-leaf group
                values = this.getValuesPivotNonLeaf(rowNode, pivotColumnDef.colId);
            }

            result[pivotColumnDef.colId] = this.aggregateValues(values, valueColumn.getAggFunc());

        });

        return result;
    }

    private aggregateRowNodeUsingValuesOnly(rowNode: RowNode, valueColumns: Column[]): any {
        var result: any = {};

        var values2d = this.getValuesNormal(rowNode, valueColumns);

        valueColumns.forEach( (valueColumn: Column, index: number) => {
            result[valueColumn.getId()] = this.aggregateValues(values2d[index], valueColumn.getAggFunc());
        });

        return result;
    }

    private getValuesPivotNonLeaf(rowNode: RowNode, colId: string): any[] {
        var values: any[] = [];
        rowNode.childrenAfterFilter.forEach( rowNode => {
            var value = rowNode.data[colId];
            values.push(value);
        });
        return values;
    }
    
    private getValuesFromMappedSet(mappedSet: any, keys: string[], valueColumn: Column): any[] {
        var mapPointer = mappedSet;
        keys.forEach( key => mapPointer = mapPointer ? mapPointer[key] : null );

        if (!mapPointer) {
            return [];
        }

        var values: any = [];
        mapPointer.forEach( (rowNode: RowNode) => {
            var value = this.valueService.getValue(valueColumn, rowNode);
            values.push(value);
        });

        return values;
    }

    private getValuesNormal(rowNode: RowNode, valueColumns: Column[]): any[][] {
        // create 2d array, of all values for all valueColumns
        var values: any[][] = [];
        valueColumns.forEach( ()=> values.push([]) );

        var valueColumnCount = valueColumns.length;
        var rowCount = rowNode.childrenAfterFilter.length;

        for (var i = 0; i<rowCount; i++) {
            var childNode = rowNode.childrenAfterFilter[i];
            for (var j = 0; j<valueColumnCount; j++) {
                var valueColumn = valueColumns[j];
                var value: any;
                // if the row is a group, then it will only have an agg result value,
                // which means valueGetter is never used.
                if (childNode.group) {
                    value = childNode.data[valueColumn.getId()];
                } else {
                    value = this.valueService.getValueUsingSpecificData(valueColumn, childNode.data, childNode);
                }
                values[j].push(value);
            }
        }

        return values;
    }

    private aggregateValues(values: any[], aggFuncOrString: string | IAggFunction): any {

        var aggFunction: IAggFunction;

        if (typeof aggFuncOrString === 'string') {
            aggFunction = this.aggFunctionService.getAggFunction(<string>aggFuncOrString);
        } else {
            aggFunction = <IAggFunction> aggFuncOrString;
        }

        if (typeof aggFunction !== 'function') {
            console.error(`ag-Grid: unrecognised aggregation function ${aggFuncOrString}`);
            return null;
        }

        var result = aggFunction(values);
        return result;
    }

}

class AggFunctionService {

    private aggFunctionsMap: {[key: string]: IAggFunction} = {};

    constructor() {

        this.aggFunctionsMap['sum'] = function(input: any[]): any {
            var result: number = null;
            var length = input.length;
            for (var i = 0; i<length; i++) {
                if (typeof input[i] === 'number') {
                    if (result === null) {
                        result = input[i];
                    } else {
                        result += input[i];
                    }
                }
            }
            return result;
        };

        this.aggFunctionsMap['first'] = function(input: any[]): any {
            if (input.length>=0) {
                return input[0];
            } else {
                return null;
            }
        };

        this.aggFunctionsMap['last'] = function(input: any[]): any {
            if (input.length>=0) {
                return input[input.length-1];
            } else {
                return null;
            }
        };

        this.aggFunctionsMap['min'] = function(input: any[]): any {
            var result: number = null;
            var length = input.length;
            for (var i = 0; i<length; i++) {
                if (typeof input[i] === 'number') {
                    if (result === null) {
                        result = input[i];
                    } else if (result > input[i]) {
                        result = input[i];
                    }
                }
            }
            return result;
        };

        this.aggFunctionsMap['max'] = function(input: any[]): any {
            var result: number = null;
            var length = input.length;
            for (var i = 0; i<length; i++) {
                if (typeof input[i] === 'number') {
                    if (result === null) {
                        result = input[i];
                    } else if (result < input[i]) {
                        result = input[i];
                    }
                }
            }
            return result;
        };

    }

    public getAggFunction(name: string): IAggFunction {
        return this.aggFunctionsMap[name];
    }

}