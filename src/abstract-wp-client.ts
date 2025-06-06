import { Notice, TFile } from "obsidian";
import WordpressPlugin from "./main";
import {
    WordPressAuthParams, WordPressClient, WordPressClientResult, WordPressClientReturnCode, WordPressMediaUploadResult, WordPressPostParams, WordPressPublishResult
} from "./wp-client";
import { WpPublishModal } from "./wp-publish-modal";
import { PostType, PostTypeConst, Term } from "./wp-api";
import { ERROR_NOTICE_TIMEOUT, WP_DEFAULT_PROFILE_NAME } from "./consts";
import { isPromiseFulfilledResult, isValidUrl, openWithBrowser, processFile, SafeAny, showError } from "./utils";
import { WpProfile } from "./wp-profile";
import { AppState } from "./app-state";
import { ConfirmCode, openConfirmModal } from "./confirm-modal";
import fileTypeChecker from "file-type-checker";
import { MatterData, Media } from "./types";
import { openPostPublishedModal } from "./post-published-modal";
import { openLoginModal } from "./wp-login-modal";
import { exportToBlob } from "@excalidraw/excalidraw";
import LZString from 'lz-string';

export const DRAWING_COMPRESSED_REG = /(\n##? Drawing\n[^`]*(?:```compressed\-json\n))([\s\S]*?)(```\n)/gm;
const DRAWING_COMPRESSED_REG_FALLBACK = /(\n##? Drawing\n(?:```compressed\-json\n)?)(.*)((```)?(%%)?)/gm;


export abstract class AbstractWordPressClient implements WordPressClient
{

    /**
     * Client name.
     */
    name = "AbstractWordPressClient";

    /**
     * 임시로 생성된 Excalidraw 이미지 파일 경로 목록
     */
    private tempExcalidrawImages: string[] = [];

    protected constructor( protected readonly plugin : WordpressPlugin, protected readonly profile : WpProfile )
    {
    }

    abstract publish(
            title : string,
            content : string,
            postParams : WordPressPostParams,
            certificate : WordPressAuthParams ) : Promise<WordPressClientResult<WordPressPublishResult>>;

    abstract getCategories( certificate : WordPressAuthParams ) : Promise<Term[]>;

    abstract getPostTypes( certificate : WordPressAuthParams ) : Promise<PostType[]>;

    abstract validateUser( certificate : WordPressAuthParams ) : Promise<WordPressClientResult<boolean>>;

    abstract getTag( name : string, certificate : WordPressAuthParams ) : Promise<Term>;

    abstract uploadMedia(
            media : Media,
            certificate : WordPressAuthParams ) : Promise<WordPressClientResult<WordPressMediaUploadResult>>;

    protected needLogin() : boolean
    {
        return true;
    }

    private async getAuth() : Promise<WordPressAuthParams>
    {
        let auth : WordPressAuthParams = {
            username : null, password : null
        };
        try
        {
            if ( this.needLogin() )
            {
                // Check if there's saved username and password
                if ( this.profile.username && this.profile.password )
                {
                    auth = {
                        username : this.profile.username, password : this.profile.password
                    };
                    const authResult = await this.validateUser( auth );
                    if ( authResult.code !== WordPressClientReturnCode.OK )
                    {
                        throw new Error( this.plugin.i18n.t( "error_invalidUser" ) );
                    }
                }
            }
        }
        catch ( error )
        {
            showError( error );
            const result = await openLoginModal( this.plugin, this.profile, async( auth ) =>
            {
                const authResult = await this.validateUser( auth );
                return authResult.code === WordPressClientReturnCode.OK;
            } );
            auth = result.auth;
        }
        return auth;
    }

    private async checkExistingProfile( matterData : MatterData )
    {
        const { profileName } = matterData;
        const isProfileNameMismatch = profileName && profileName !== this.profile.name;
        if ( isProfileNameMismatch )
        {
            const confirm = await openConfirmModal( {
                message : this.plugin.i18n.t( "error_profileNotMatch" ), cancelText : this.plugin.i18n.t( "profileNotMatch_useOld", {
                    profileName : matterData.profileName
                } ), confirmText : this.plugin.i18n.t( "profileNotMatch_useNew", {
                    profileName : this.profile.name
                } )
            }, this.plugin );
            if ( confirm.code !== ConfirmCode.Cancel )
            {
                delete matterData.postId;
                matterData.categories = this.profile.lastSelectedCategories ?? [ 1 ];
            }
        }
    }

    private async tryToPublish
    (
        params : 
        {
            postParams        : WordPressPostParams, 
            auth              : WordPressAuthParams, 
            updateMatterData? : ( matter : MatterData ) => void,
        }
    ) : Promise<WordPressClientResult<WordPressPublishResult>>
    {
        const { postParams, auth, updateMatterData } = params;
        
        const tagTerms = await this.getTags( postParams.tags, auth );
        postParams.tags = tagTerms.map( term => term.id );
        
        postParams.content = await this.convertExcalidrawToImage( postParams.content );
        
        await this.updatePostImages
        ( {
            auth, postParams
        } );
        
        const html = AppState.markdownParser.render( postParams.content );
    
        const blockHtml = this.convertToWordPressBlocks( html );
        
        try
        {
            const result = await this.publish( postParams.title ?? "A post from Obsidian!", blockHtml, postParams, auth );
            if ( result.code === WordPressClientReturnCode.Error )
            {
                throw new Error( this.plugin.i18n.t( "error_publishFailed", {
                    code : result.error.code as string, message : result.error.message
                } ) );
            }
            else
            {
                new Notice( this.plugin.i18n.t( "message_publishSuccessfully" ) );
                // post id will be returned if creating, true if editing
                const postId = result.data.postId;
                if ( postId )
                {
                    // const modified = matter.stringify(postParams.content, matterData, matterOptions);
                    // this.updateFrontMatter(modified);
                    // const file = this.plugin.app.workspace.getActiveFile();
                    // if ( file )
                    // {
                    //     await this.plugin.app.fileManager.processFrontMatter( file, fm =>
                    //     {
                    //         fm.profileName = this.profile.name;
                    //         fm.postId = postId;
                    //         fm.postType = postParams.postType;
                    //         if ( postParams.postType === PostTypeConst.Post )
                    //         {
                    //             fm.categories = postParams.categories;
                    //         }
                    //         if ( isFunction( updateMatterData ) )
                    //         {
                    //             updateMatterData( fm );
                    //         }
                    //     } );
                    // }

                    if ( this.plugin.settings.rememberLastSelectedCategories )
                    {
                        this.profile.lastSelectedCategories = ( result.data as SafeAny ).categories;
                        await this.plugin.saveSettings();
                    }

                    if ( this.plugin.settings.showWordPressEditConfirm )
                    {
                        openPostPublishedModal( this.plugin )
                        .then( () =>
                        {
                            openWithBrowser( `${ this.profile.endpoint }/wp-admin/post.php`, {
                                action : "edit", post : postId
                            } );
                        } );
                    }
                }
            }
            
            return result;
        }
        finally 
        {
            await this.cleanupTempExcalidrawImages();
        }
    }
    
    private async convertExcalidrawToImage( content : string ) : Promise<string>
    {
        let processedContent = content;
        
        const linkRegex = /!\[\[([^|\]\n]+)((\|[^|\]\n]+)*)?\]\]/g;
        const matches = [ ...content.matchAll( linkRegex ) ];
        
        for ( const match of matches )
        {
            const fullMatch = match[ 0 ];
            const fileName  = match[ 1 ].trim();
            const options   = match[ 2 ] || '';
            
            if ( fileName.endsWith( '.excalidraw' ) )
            {
                try 
                {
                    console.log(`Converting Excalidraw file: ${fileName}`);
                    
                    const exportImageFile = await this.exportExcalidrawToImage( fileName );
                    
                    if ( exportImageFile )
                    {
                        console.log(`Generated image file: ${exportImageFile}`);
                        
                        const activeFile = this.plugin.app.workspace.getActiveFile();
                        const folderPath = activeFile?.parent?.path || "";
                        const filePath = `${folderPath}/${exportImageFile}`;
                        
                        const fileExists = await this.plugin.app.vault.adapter.exists(filePath);
                        console.log(`File exists check: ${fileExists} for path: ${filePath}`);
                        
                        const imageTag = `![[${exportImageFile}${options}]]`;
                        const escapedMatch = this.escapeRegExp(fullMatch);
                        
                        processedContent = processedContent.replace(new RegExp(escapedMatch, 'g'), imageTag);
                        
                        console.log(`Replaced tag from ${fullMatch} to ${imageTag}`);
                    }
                }
                catch ( error )
                {
                    console.error( `Error converting Excalidraw file ${fileName}:`, error );
                }
            }
        }

        return processedContent;
    }
    
    private async exportExcalidrawToImage( fileName : string ) : Promise<string | null>
    {
        let imageFileName : string | null = null;
        
        let file = this.plugin.app.metadataCache.getFirstLinkpathDest( fileName, fileName );
        
        if ( file instanceof TFile )
        {
            let excalidrawContent = await this.plugin.app.vault.cachedRead( file );
            let decompressedContent = this.decompressExcalidrawContent( excalidrawContent );
            
            let json = JSON.parse( decompressedContent );
            
            let embeddedFiles = await this.getExcalidrawEmbeddedFiles( excalidrawContent );
            
            let blob = exportToBlob
            ( {
                elements : json['elements'],
                files    : embeddedFiles
            } );
                
            if ( blob )
            {
                imageFileName = `excalidraw-${ Date.now() }.png`;

                try
                {
                    const actualBlob = await blob;
                    const arrayBuffer = await actualBlob.arrayBuffer();
                    const activeFile = this.plugin.app.workspace.getActiveFile();
                    const folderPath = activeFile?.parent?.path || "";
                    const filePath = `${ folderPath }/${ imageFileName }`;
                    await this.plugin.app.vault.createBinary( filePath, arrayBuffer );

                    if ( !this.tempExcalidrawImages )
                    {
                        this.tempExcalidrawImages = [];
                    }
                    
                    this.tempExcalidrawImages.push( filePath );

                    return imageFileName;
                }
                catch ( error )
                {
                    console.error( "Error saving PNG file:", error );
                    return null;
                }
            }
        }
        
        return imageFileName;
    }
    
    private async cleanupTempExcalidrawImages() : Promise<void>
    {
        if ( this.tempExcalidrawImages && this.tempExcalidrawImages.length > 0 )
        {
            for ( const filePath of this.tempExcalidrawImages )
            {
                try
                {
                    await this.plugin.app.vault.adapter.remove( filePath );
                }
                catch ( error )
                {
                    console.error( `Error removing temporary file ${ filePath }:`, error );
                }
            }
            
            this.tempExcalidrawImages = [];
        }
    }
    
    private decompressExcalidrawContent( content : string ) : string
    {
        let match = content.matchAll( DRAWING_COMPRESSED_REG );
        let parts;

        parts = match.next();

        if ( parts.done ) 
        {
            match = content.matchAll( DRAWING_COMPRESSED_REG_FALLBACK );
            parts = match.next();
        }

        if ( parts.value && parts.value.length > 1 )
        {
            let decompressContent = parts.value[ 2 ];
            
            let cleanedData = "";
            const length = decompressContent.length;

            for ( let i = 0; i < length; i++ )
            {
                const char = decompressContent[ i ];
                if ( char !== "\n" && char !== "\r" )
                {
                    cleanedData += char;
                }
            }
        
            return LZString.decompressFromBase64( cleanedData );
        }
        
        return content;
    }
    
    private async getExcalidrawEmbeddedFiles( content : string ) : Promise<Record<string, SafeAny>>
    {
        const embeddedFiles: Record<string, SafeAny> = {};
        const embeddedFilesMatch = content.match(/## Embedded Files\s+([\s\S]*?)(?=\s*##|$)/);

        if ( embeddedFilesMatch && embeddedFilesMatch[ 1 ] )
        {
            const fileEntries = embeddedFilesMatch[ 1 ].trim().split( "\n" );

            for ( const entry of fileEntries )
            {
                const fileMatch = entry.match( /([a-f0-9]+):\s*\[\[(.*?)\]\]/ );

                if ( fileMatch && fileMatch.length >= 3 )
                {
                    const fileId = fileMatch[ 1 ];
                    const filePath = fileMatch[ 2 ].trim();

                    try
                    {
                        const imageFile = this.plugin.app.metadataCache.getFirstLinkpathDest( filePath, filePath );

                        if ( imageFile instanceof TFile )
                        {
                            const fileContent = await this.plugin.app.vault.readBinary( imageFile );
                            const fileType = fileTypeChecker.detectFile( fileContent );
                            const mimeType = fileType?.mimeType || "image/png";

                            const base64Content = this.arrayBufferToBase64String( fileContent );
                            const dataURL = `data:${ mimeType };base64,${ base64Content }`;

                            embeddedFiles[ fileId ] =
                            {
                                id : fileId, dataURL, mimeType, created : Date.now(), lastRetrieved : Date.now()
                            };
                        }
                    }
                    catch ( error )
                    {
                        console.error( `Error loading embedded file ${ filePath }:`, error );
                    }
                }
            }
        }
        
        return embeddedFiles;
    }

    private async updatePostImages( params : {
        postParams : WordPressPostParams, auth : WordPressAuthParams,
    } ) : Promise<void>
    {
        const { postParams, auth } = params;

        const activeFile = this.plugin.app.workspace.getActiveFile();
        if ( activeFile === null )
        {
            throw new Error( this.plugin.i18n.t( "error_noActiveFile" ) );
        }
        const { activeEditor } = this.plugin.app.workspace;
        if ( activeEditor && activeEditor.editor )
        {
            // process images
            const images = getImages( postParams.content );
            for ( const img of images )
            {
                if ( !img.srcIsUrl )
                {
                    img.src = img.src.split( '|' )[ 0 ];
                    img.src = decodeURI( img.src );
                    
                    const fileName = img.src.split( "/" ).pop();
                    if ( fileName === undefined )
                    {
                        continue;
                    }
                    
                    const imgFile = this.plugin.app.metadataCache.getFirstLinkpathDest( img.src, fileName );
                    if ( imgFile instanceof TFile )
                    {
                        const content = await this.plugin.app.vault.readBinary( imgFile );
                        const fileType = fileTypeChecker.detectFile( content );
                        
                        const result = await this.uploadMedia
                        ( {
                            mimeType : fileType?.mimeType ?? "application/octet-stream", 
                            fileName : imgFile.name, 
                            content : content
                        }, auth );
                        
                        if ( result.code === WordPressClientReturnCode.OK )
                        {
                            if ( img.width && img.height )
                            {
                                postParams.content = postParams.content.replace( img.original, `![[${ result.data.url }|${ img.width }x${ img.height }]]` );
                            }
                            else if ( img.width )
                            {
                                postParams.content = postParams.content.replace( img.original, `![[${ result.data.url }|${ img.width }]]` );
                            }
                            else
                            {
                                postParams.content = postParams.content.replace( img.original, `![[${ result.data.url }]]` );
                            }
                        }
                        else
                        {
                            if ( result.error.code === WordPressClientReturnCode.ServerInternalError )
                            {
                                new Notice( result.error.message, ERROR_NOTICE_TIMEOUT );
                            }
                            else
                            {
                                new Notice( this.plugin.i18n.t( "error_mediaUploadFailed", {
                                    name : imgFile.name
                                } ), ERROR_NOTICE_TIMEOUT );
                            }
                        }
                    }
                }
                else
                {
                    // src is a url, skip uploading
                }
            }
            if ( this.plugin.settings.replaceMediaLinks )
            {
                activeEditor.editor.setValue( postParams.content );
            }
        }
    }

    async publishPost( defaultPostParams? : WordPressPostParams ) : Promise<WordPressClientResult<WordPressPublishResult>>
    {
        try
        {
            if ( !this.profile.endpoint || this.profile.endpoint.length === 0 )
            {
                throw new Error( this.plugin.i18n.t( "error_noEndpoint" ) );
            }
            // const { activeEditor } = this.plugin.app.workspace;
            const file = this.plugin.app.workspace.getActiveFile();
            if ( file === null )
            {
                throw new Error( this.plugin.i18n.t( "error_noActiveFile" ) );
            }

            // get auth info
            const auth = await this.getAuth();

            // read note title, content and matter data
            const title = file.basename;
            const { content, matter : matterData } = await processFile( file, this.plugin.app );

            // check if profile selected is matched to the one in note property,
            // if not, ask whether to update or not
            await this.checkExistingProfile( matterData );

            // now we're preparing the publishing data
            let postParams : WordPressPostParams;
            let result : WordPressClientResult<WordPressPublishResult> | undefined;
            if ( defaultPostParams )
            {
                postParams = this.readFromFrontMatter( title, matterData, defaultPostParams );
                postParams.content = content;
                result = await this.tryToPublish( {
                    auth, postParams
                } );
            }
            else
            {
                const categories = await this.getCategories( auth );
                const selectedCategories = matterData.categories as number[] ?? this.profile.lastSelectedCategories ?? [ 1 ];
                const postTypes = await this.getPostTypes( auth );
                if ( postTypes.length === 0 )
                {
                    postTypes.push( PostTypeConst.Post );
                }
                const selectedPostType = matterData.postType ?? PostTypeConst.Post;
                result = await new Promise( resolve =>
                {
                    const publishModal = new WpPublishModal( this.plugin, { items : categories, selected : selectedCategories }, { items : postTypes, selected : selectedPostType }, async(
                            postParams : WordPressPostParams,
                            updateMatterData : ( matter : MatterData ) => void ) =>
                    {
                        postParams = this.readFromFrontMatter( title, matterData, postParams );
                        postParams.content = content;
                        try
                        {
                            const r = await this.tryToPublish( {
                                auth, postParams, updateMatterData
                            } );
                            if ( r.code === WordPressClientReturnCode.OK )
                            {
                                publishModal.close();
                                resolve( r );
                            }
                        }
                        catch ( error )
                        {
                            if ( error instanceof Error )
                            {
                                return showError( error );
                            }
                            else
                            {
                                throw error;
                            }
                        }
                    }, matterData );
                    publishModal.open();
                } );
            }
            if ( result )
            {
                return result;
            }
            else
            {
                throw new Error( this.plugin.i18n.t( "message_publishFailed" ) );
            }
        }
        catch ( error )
        {
            if ( error instanceof Error )
            {
                return showError( error );
            }
            else
            {
                throw error;
            }
        }
    }

    private async getTags( tags : string[], certificate : WordPressAuthParams ) : Promise<Term[]>
    {
        const results = await Promise.allSettled( tags.map( name => this.getTag( name, certificate ) ) );
        const terms : Term[] = [];
        results
        .forEach( result =>
        {
            if ( isPromiseFulfilledResult<Term>( result ) )
            {
                terms.push( result.value );
            }
        } );
        return terms;
    }

    private readFromFrontMatter(
            noteTitle : string,
            matterData : MatterData,
            params : WordPressPostParams ) : WordPressPostParams
    {
        const postParams = { ...params };
        postParams.title = noteTitle;
        if ( matterData.title )
        {
            postParams.title = matterData.title;
        }
        if ( matterData.postId )
        {
            postParams.postId = matterData.postId;
        }
        postParams.profileName = matterData.profileName ?? WP_DEFAULT_PROFILE_NAME;
        if ( matterData.postType )
        {
            postParams.postType = matterData.postType;
        }
        else
        {
            // if there is no post type in matter-data, assign it as 'post'
            postParams.postType = PostTypeConst.Post;
        }
        if ( postParams.postType === PostTypeConst.Post )
        {
            // only 'post' supports categories and tags
            if ( matterData.categories )
            {
                postParams.categories = matterData.categories as number[] ?? this.profile.lastSelectedCategories;
            }
            if ( matterData.tags )
            {
                postParams.tags = matterData.tags as string[];
            }
        }
        return postParams;
    }

    /// 일반 HTML을 워드프레스 블록 형식으로 변환합니다. 이미 워드프레스 블록 형식인 경우 그대로 유지합니다.
    private convertToWordPressBlocks( html : string ) : string
    {
        // 이미 워드프레스 블록 형식으로 감싸진 부분은 그대로 유지
        const blocks : string[] = [];
        const blockRegex = /<!-- wp:.*?-->([\s\S]*?)<!-- \/wp:.*?-->/g;
        
        // 기존 워드프레스 블록이 있는지 확인
        let hasBlocks = blockRegex.test( html );
        blockRegex.lastIndex = 0; // 정규식 인덱스 초기화
        
        if ( hasBlocks )
        {
            // 블록이 이미 있는 경우, 블록과 블록 사이의 내용을 적절히 처리
            let lastIndex = 0;
            let match;
            
            // 이미 블록 형식인 부분을 찾아서 보존
            while ( ( match = blockRegex.exec( html ) ) !== null )
            {
                // 블록 이전의 텍스트가 있으면 처리
                if ( match.index > lastIndex )
                {
                    const nonBlockHtml = html.substring( lastIndex, match.index ).trim();
                    
                    if ( nonBlockHtml )
                    {
                        // 중간 내용을 분석하여 적절한 블록으로 분할
                        const intermediateBlocks = this.splitContentIntoBlocks( nonBlockHtml );
                        blocks.push( ...intermediateBlocks );
                    }
                }
                
                // 기존 블록 유지
                blocks.push( match[ 0 ] );
                lastIndex = match.index + match[ 0 ].length;
            }
            
            // 마지막 블록 이후의 텍스트가 있으면 처리
            if ( lastIndex < html.length )
            {
                const remainingHtml = html.substring( lastIndex ).trim();
                
                if ( remainingHtml )
                {
                    const remainingBlocks = this.splitContentIntoBlocks( remainingHtml );
                    blocks.push( ...remainingBlocks );
                }
            }
        }
        else
        {
            // 블록이 없는 경우, 전체 내용을 분석하여 블록으로 분할
            const contentBlocks = this.splitContentIntoBlocks( html );
            blocks.push( ...contentBlocks );
        }
        
        return blocks.join( "\n\n" );
    }

    /// HTML 컨텐츠를 개별 요소로 분할하고 각각을 워드프레스 블록으로 변환합니다.
    private splitContentIntoBlocks( html : string ) : string[]
    {
        const blocks : string[] = [];

        // HTML을 주요 블록 단위로 분할 (줄바꿈 기준)
        const htmlLines = html.split( "\n" );

        let i = 0;
        while ( i < htmlLines.length )
        {
            const line = htmlLines[ i ];

            // 제목 태그 처리
            const headingMatch = line.match( /^<h([1-6])>(.*?)<\/h\1>$/ );
            if ( headingMatch )
            {
                const level     = headingMatch[ 1 ];
                const content   = headingMatch[ 2 ];
                const levelAttr = level !== "2" ? ` {"level":${ level }}` : "";
                blocks.push( this.createWpBlock( "heading", `<h${ level }>${ content }</h${ level }>`, levelAttr ) );
                i++;
                continue;
            }

            // 수평선 처리
            if ( line.match( /^<hr\s*\/?>$/ ) )
            {
                const content = `<hr class="wp-block-separator has-text-color has-alpha-channel-opacity has-background is-style-wide" style="margin-top:var(--wp--preset--spacing--50);margin-bottom:var(--wp--preset--spacing--50);background-color:#ececec;color:#ececec"/>`;
                const attributes = ` {"className":"is-style-wide","style":{"spacing":{"margin":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50"}},"color":{"background":"#ececec"}}}`;
                blocks.push( this.createWpBlock( "separator", content, attributes ) );
                i++;
                continue;
            }

            // 테이블 처리 (시작)
            if ( line.match( /^<table>/ ) )
            {
                let tableContent = "";
                let j = i;
                
                // 테이블 전체 내용 수집
                while ( j < htmlLines.length )
                {
                    const tableLine = htmlLines[ j ];
                    tableContent += tableLine;
                    if ( tableLine.includes( "</table>" ) )
                    {
                        break;
                    }
                    if ( j > i )
                    {
                        tableContent += "\n";
                    }
                    j++;
                }
                
                // 테이블 헤더와 바디 분리
                const hasHead = tableContent.includes( "<thead>" );
                const hasFoot = tableContent.includes( "<tfoot>" );
                
                // 테이블 어트리뷰트 설정
                const tableAttributes = ` {"hasFixedLayout":true,"className":"is-style-regular"}`;
                
                blocks.push( this.createWpBlock( "table", this.formatTableContent( tableContent, hasHead, hasFoot ), tableAttributes ) );
                i = j + 1;
                continue;
            }

            // 코드 블록 처리 (시작)
            if ( line.match( /^<pre>/ ) )
            {
                let codeLines = [];
                let j = i;
            
                // 코드 블록 전체 수집
                while ( j < htmlLines.length )
                {
                    const codeLine = htmlLines[ j ];
                    if ( codeLine.includes( "</pre>" ) )
                    {
                        break;
                    }
                    
                    codeLines.push( codeLine );
                    j++;
                }
            
                // 배열을 조인하여 개행 처리
                let codeContent = codeLines.join( "\n" );
            
                // <pre>, </pre>, <code>, </code> 태그 제거
                codeContent = codeContent.replace( /<\/?(?:pre|code)[^>]*>/g, "" );
            
                blocks.push( this.createWpBlock( "code", `<pre class="wp-block-code"><code>${ codeContent }</code></pre>` ) );
                i = j + 1;
                continue;
            }

            // 목록 처리 (ul)
            if ( line.match( /^<ul>/ ) )
            {
                let listContent = "";
                let j = i;

                while ( j < htmlLines.length )
                {
                    const listLine = htmlLines[ j ];
                    listContent += listLine;
                    if ( listLine.includes( "</ul>" ) )
                    {
                        break;
                    }
                    if ( j > i )
                    {
                        listContent += "\n";
                    }
                    j++;
                }

                blocks.push( this.createWpBlock( "list", listContent ) );
                i = j + 1;
                continue;
            }

            // 목록 처리 (ol)
            if ( line.match( /^<ol>/ ) )
            {
                let listContent = "";
                let j = i;

                while ( j < htmlLines.length )
                {
                    const listLine = htmlLines[ j ];
                    listContent += listLine;
                    if ( listLine.includes( "</ol>" ) )
                    {
                        break;
                    }
                    if ( j > i )
                    {
                        listContent += "\n";
                    }
                    j++;
                }

                blocks.push( this.createWpBlock( "list", listContent, " {\"ordered\":true}" ) );
                i = j + 1;
                continue;
            }

            // 인용구 처리
            if ( line.match( /^<blockquote>/ ) )
            {
                let quoteContent = "";
                let j = i;

                while ( j < htmlLines.length )
                {
                    const quoteLine = htmlLines[ j ];
                    quoteContent += quoteLine;
                    if ( quoteLine.includes( "</blockquote>" ) )
                    {
                        break;
                    }
                    if ( j > i )
                    {
                        quoteContent += "\n";
                    }
                    j++;
                }

                // blockquote 태그 제거하고 내용만 추출
                const innerContent = quoteContent.replace( /<\/?blockquote>/g, "" ).trim();

                // 콜아웃 문법 확인
                if ( this.hasCalloutSyntax( innerContent ) )
                {
                    this.processCalloutContentSimple( innerContent, blocks );
                }
                else
                {
                    blocks.push( this.createWpBlock( "quote", `<blockquote class="wp-block-quote">${ innerContent }</blockquote>` ) );
                }

                i = j + 1;
                continue;
            }

            // 단락 처리
            const paragraphMatch = line.match( /^<p>(.*?)<\/p>$/ );
            if ( paragraphMatch )
            {
                const content = paragraphMatch[ 1 ];

                // 이미지만 포함된 단락인지 확인
                const imgMatch = content.match( /^\s*<img\s+([^>]*?)>\s*$/ );
                if ( imgMatch )
                {
                    const imgAttributes = imgMatch[ 1 ];
                    const srcMatch = imgAttributes.match( /src="([^"]*)"/ );
                    const altMatch = imgAttributes.match( /alt="([^"]*)"/ );

                    if ( srcMatch )
                    {
                        const imgSrc = srcMatch[ 1 ];
                        const imgAlt = altMatch ? altMatch[ 1 ] : "";
                        const tempId = Math.floor( Math.random() * 1000 ) + 600;

                        const imageContent = `<figure class="wp-block-image aligncenter size-large"><img src="${ imgSrc }" alt="${ imgAlt }" class="wp-image-${ tempId }"/></figure>`;
                        const imageAttributes = ` {"id":${ tempId },"sizeSlug":"large","linkDestination":"none","align":"center"}`;
                        blocks.push( this.createWpBlock( "image", imageContent, imageAttributes ) );
                        i++;
                        continue;
                    }
                }

                // 콜아웃 문법 확인
                if ( this.hasCalloutSyntax( content ) )
                {
                    this.processCalloutContentSimple( content, blocks );
                }
                else
                {
                    blocks.push( this.createWpBlock( "paragraph", `<p>${ content }</p>` ) );
                }

                i++;
                continue;
            }

            // <br> 태그 처리
            if ( line.match( /^<br\s*\/?>$/ ) )
            {
                const content = `<div style="height:50px" aria-hidden="true" class="wp-block-spacer"></div>`;
                blocks.push( this.createWpBlock( "spacer", content, " {\"height\":\"50px\"}" ) );
                i++;
                continue;
            }

            // 기타 텍스트 처리 (HTML 태그 제거)
            const textContent = line.replace( /<(?!\/?(code|strong|em|b|i)\b)[^>]*>/g, "" ).trim();
            if ( textContent )
            {
                blocks.push( this.createParagraphBlock( textContent ) );
            }

            i++;
        }

        return blocks;
    }
    
    /**
     * 워드프레스 블록을 생성합니다.
     */
    private createWpBlock( blockType : string, content : string, attributes : string = "" ) : string
    {
        return `<!-- wp:${ blockType }${ attributes } -->
${ content }
<!-- /wp:${ blockType } -->`;
    }

    /**
     * 텍스트로부터 단락 블록을 생성합니다.
     */
    private createParagraphBlock( text : string ) : string
    {
        return `<!-- wp:paragraph -->
<p>${ text }</p>
<!-- /wp:paragraph -->`;
    }

    /**
     * 텍스트에 콜아웃 문법([!info], [!warning] 등)이 포함되어 있는지 확인합니다.
     */
    private hasCalloutSyntax( content : string ) : boolean
    {
        return /\[!(info|warning|note|tip|caution|danger|success|failure|bug|example|quote|cite|abstract|summary|tldr|info\+|question|help|faq|error)\]/i.test( content );
    }

    /**
     * 콜아웃 내용을 워드프레스 Alerts 블록으로 변환합니다.
     */
    private processCalloutContentSimple( content : string, blocks : string[] ) : void
    {
        const calloutMatch = content.match( /\[!(info|warning|note|tip|caution|danger|success|failure|bug|example|quote|cite|abstract|summary|tldr|info\+|question|help|faq|error)\]\s*([^\n]*)/i );

        if ( calloutMatch )
        {
            const calloutType = calloutMatch[ 1 ].toLowerCase();
            const calloutTitle = calloutMatch[ 2 ] ? calloutMatch[ 2 ].trim() : calloutType.charAt( 0 )
            .toUpperCase() + calloutType.slice( 1 );

            let calloutContent = content
            .replace( /\[!(info|warning|note|tip|caution|danger|success|failure|bug|example|quote|cite|abstract|summary|tldr|info\+|question|help|faq|error)\]\s*[^\n]*/i, "" )
            .replace( /<\/?p>/g, "" )
            .trim();

            // 워드프레스 Alerts 유형 매핑
            let alertType = "info";
            if ( calloutType === "warning" || calloutType === "caution" || calloutType === "danger" )
            {
                alertType = "warning";
            }
            else if ( calloutType === "success" )
            {
                alertType = "success";
            }
            else if ( calloutType === "error" || calloutType === "failure" )
            {
                alertType = "error";
            }

            const alertContent = `<!-- wp:paragraph {"placeholder":""} -->
  "${ calloutContent }"
  <!-- /wp:paragraph -->`;
            const alertAttributes = ` {"alertType":"${ alertType }","alertTitle":"${ calloutTitle }","maximumWidthUnit":"%","maximumWidth":"100","baseFontSize":13,"variant":"left-accent","uniqueId":"alerts-dlx-${ Math.random()
            .toString( 36 )
            .substring( 2, 10 ) }","className":"is-style-${ alertType }"}`;

            blocks.push( this.createWpBlock( "mediaron/alerts-dlx-chakra", alertContent, alertAttributes ) );
        }
    }

    /**
     * ArrayBuffer를 Base64 문자열로 변환합니다.
     * @param buffer 변환할 ArrayBuffer
     * @returns Base64로 인코딩된 문자열
     */
    private arrayBufferToBase64String(buffer: ArrayBuffer): string {
        // 바이트 배열로 변환
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const len = bytes.byteLength;
        
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        
        // Base64로 인코딩
        return window.btoa(binary);
    }

    private escapeRegExp(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * HTML 테이블 콘텐츠를 워드프레스 테이블 블록에 맞게 포맷팅합니다.
     * @param tableContent 원본 HTML 테이블 콘텐츠
     * @param hasHead 테이블 헤더 포함 여부
     * @param hasFoot 테이블 푸터 포함 여부
     * @returns 워드프레스 테이블 블록에 맞게 포맷팅된 HTML
     */
    private formatTableContent( tableContent : string, hasHead : boolean, hasFoot : boolean ) : string
    {
        // 원본 테이블 클래스 및 스타일 속성 추가
        const formattedTable = tableContent.replace( 
            /<table>/, 
            '<figure class="wp-block-table is-style-regular"><table class="has-fixed-layout">' 
        );
        
        // 테이블 닫는 태그 수정
        const finalTable = formattedTable.replace( 
            /<\/table>/, 
            '</table></figure>' 
        );
        
        return finalTable;
    }
}


interface Image
{
    original   : string;
    src        : string;
    altText?   : string;
    width?     : string;
    height?    : string;
    srcIsUrl   : boolean;
    startIndex : number;
    endIndex   : number;
    file?      : TFile;
    content?   : ArrayBuffer;
}


function getImages( content : string ) : Image[]
{
    const paths : Image[] = [];

    // for ![Alt Text](image-url)
    let regex = /(!\[(.*?)(?:\|(\d+)(?:x(\d+))?)?]\((.*?)\))/g;
    let match;
    
    while ( ( match = regex.exec( content ) ) !== null )
    {
        paths.push
        ( {
            src        : match[ 5 ], 
            altText    : match[ 2 ], 
            width      : match[ 3 ], 
            height     : match[ 4 ], 
            original   : match[ 1 ], 
            startIndex : match.index, 
            endIndex   : match.index + match.length, 
            srcIsUrl   : isValidUrl( match[ 5 ] )
        } );
    }

    // for ![[image-name|옵션...]]
    regex = /(!\[\[([^\]]+)\]\])/g;
    
    while ( ( match = regex.exec( content ) ) !== null )
    {
        const srcRaw = match[ 2 ];
        const src = srcRaw.split( '|' )[ 0 ];
        paths.push
        ( {
            src        : src, 
            original   : match[ 1 ], 
            width      : undefined, 
            height     : undefined, 
            startIndex : match.index, 
            endIndex   : match.index + match.length, 
            srcIsUrl   : isValidUrl( src )
        } );
    }

    return paths;
}
