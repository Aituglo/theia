/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject, postConstruct } from 'inversify';
import { BaseWidget, PanelLayout, Widget, Message, MessageLoop, StatefulWidget, CompositeTreeNode } from '@theia/core/lib/browser';
import { ConsoleSession } from './console-session';
import { DisposableCollection } from '@theia/core/lib/common';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import URI from '@theia/core/lib/common/uri';
import { MonacoEditorProvider } from '@theia/monaco/lib/browser/monaco-editor-provider';
import { ProtocolToMonacoConverter, MonacoToProtocolConverter } from 'monaco-languageclient/lib';
import { ElementExt } from '@phosphor/domutils';
import { ConsoleContentWidget } from './content/console-content-widget';
import { ConsoleSessionNode } from './content/console-content-tree';
import { ConsoleHistory } from './console-history';

export const ConsoleOptions = Symbol('ConsoleWidgetOptions');
export interface ConsoleOptions {
    id: string
    title?: {
        label?: string
        iconClass?: string
        caption?: string
    }
    input: {
        uri: URI
        options?: MonacoEditor.IOptions
    }
}

@injectable()
export class ConsoleWidget extends BaseWidget implements StatefulWidget {

    static styles = {
        node: 'theia-console-widget',
        content: 'theia-console-content',
        input: 'theia-console-input',
    };

    @inject(ConsoleOptions)
    protected readonly options: ConsoleOptions;

    @inject(MonacoToProtocolConverter)
    protected readonly m2p: MonacoToProtocolConverter;

    @inject(ProtocolToMonacoConverter)
    protected readonly p2m: ProtocolToMonacoConverter;

    @inject(ConsoleContentWidget)
    readonly content: ConsoleContentWidget;

    @inject(ConsoleHistory)
    protected readonly history: ConsoleHistory;

    @inject(MonacoEditorProvider)
    protected readonly editorProvider: MonacoEditorProvider;

    protected _input: MonacoEditor;

    constructor() {
        super();
        this.node.classList.add(ConsoleWidget.styles.node);
    }

    @postConstruct()
    protected async init(): Promise<void> {
        const { id, title } = this.options;
        const { label, iconClass, caption } = Object.assign({}, title);
        this.id = id;
        this.title.closable = true;
        this.title.label = label || id;
        if (iconClass) {
            this.title.iconClass = iconClass;
        }
        this.title.caption = caption || label || id;

        const layout = this.layout = new PanelLayout();

        this.content.node.classList.add(ConsoleWidget.styles.content);
        this.toDispose.push(this.content);
        layout.addWidget(this.content);

        const inputWidget = new Widget();
        inputWidget.node.classList.add(ConsoleWidget.styles.input);
        layout.addWidget(inputWidget);

        const input = this._input = await this.createInput(inputWidget.node);
        this.toDispose.push(input);
        this.toDispose.push(input.getControl().onDidLayoutChange(() => this.resizeContent()));
        this.toDispose.push(input.getControl().onDidChangeConfiguration(({ fontInfo }) => fontInfo && this.updateFont()));
        this.updateFont();
    }

    protected createInput(node: HTMLElement): Promise<MonacoEditor> {
        return this.editorProvider.createInline(this.options.input.uri, node, this.options.input.options);
    }

    protected updateFont(): void {
        const { fontFamily, fontSize, lineHeight } = this._input.getControl().getConfiguration().fontInfo;
        this.content.node.style.fontFamily = fontFamily;
        this.content.node.style.fontSize = fontSize + 'px';
        this.content.node.style.lineHeight = lineHeight + 'px';
    }

    protected _session: ConsoleSession | undefined;
    protected readonly toDisposeOnSession = new DisposableCollection();
    set session(session: ConsoleSession | undefined) {
        if (this._session === session) {
            return;
        }
        this._session = session;
        this.content.model.root = ConsoleSessionNode.to(session);
        if (this._session) {
            this.toDisposeOnSession.push(this._session.onDidChange(() => this.content.model.refresh()));
            this.toDispose.push(this.toDisposeOnSession);
        }
    }
    get session(): ConsoleSession | undefined {
        return this._session;
    }

    get input(): MonacoEditor {
        return this._input;
    }

    selectAll(): void {
        document.getSelection().selectAllChildren(this.content.node);
    }

    collapseAll(): void {
        const { root } = this.content.model;
        if (CompositeTreeNode.is(root)) {
            this.content.model.collapseAll(root);
        }
    }

    clear(): void {
        if (this.session) {
            this.session.clear();
        }
    }

    async execute(): Promise<void> {
        const value = this._input.getControl().getValue();
        this._input.getControl().setValue('');
        this.history.push(value);
        if (this.session) {
            const listener = this.content.model.onNodeRefreshed(() => {
                listener.dispose();
                this.revealLastOutput();
            });
            await this.session.execute(value);
        }
    }

    navigateBack(): void {
        const value = this.history.previous;
        if (value === undefined) {
            return;
        }
        const editor = this.input.getControl();
        editor.setValue(value);
        editor.setPosition({
            lineNumber: 1,
            column: 1
        });
    }

    navigateForward(): void {
        const value = this.history.next || '';
        const editor = this.input.getControl();
        editor.setValue(value);
        const lineNumber = editor.getModel().getLineCount();
        const column = editor.getModel().getLineMaxColumn(lineNumber);
        editor.setPosition({ lineNumber, column });
    }

    protected revealLastOutput(): void {
        const { root } = this.content.model;
        if (ConsoleSessionNode.is(root)) {
            this.content.model.selectNode(root.children[root.children.length - 1]);
        }
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this._input.focus();
    }

    protected totalHeight = -1;
    protected totalWidth = -1;
    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.totalWidth = msg.width;
        this.totalHeight = msg.height;
        this._input.resizeToFit();
        this.resizeContent();
    }

    protected resizeContent(): void {
        this.totalHeight = this.totalHeight < 0 ? this.computeHeight() : this.totalHeight;
        const inputHeight = this._input.getControl().getLayoutInfo().height;
        const contentHeight = this.totalHeight - inputHeight;
        this.content.node.style.height = `${contentHeight}px`;
        MessageLoop.sendMessage(this.content, new Widget.ResizeMessage(this.totalWidth, contentHeight));
    }

    protected computeHeight(): number {
        const { verticalSum } = ElementExt.boxSizing(this.node);
        return this.node.offsetHeight - verticalSum;
    }

    storeState(): object {
        const history = this.history.store();
        const input = this.input.storeViewState();
        return {
            history,
            input
        };
    }

    restoreState(oldState: object): void {
        if ('history' in oldState) {
            // tslint:disable-next-line:no-any
            this.history.restore((<any>oldState)['history']);
        }
        this.input.getControl().setValue(this.history.current || '');
        if ('input' in oldState) {
            // tslint:disable-next-line:no-any
            this.input.restoreViewState((<any>oldState)['input']);
        }
    }

}
