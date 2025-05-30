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
import { isFunction } from "lodash-es";


export abstract class AbstractWordPressClient implements WordPressClient
{

    /**
     * Client name.
     */
    name = "AbstractWordPressClient";

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
        await this.updatePostImages( {
            auth, postParams
        } );
        
        // 처리된 마크다운을 HTML로 변환
        const html = AppState.markdownParser.render( postParams.content );
        
        // HTML을 워드프레스 블록으로 변환
        const blockHtml = this.convertToWordPressBlocks( html );
        
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
                const file = this.plugin.app.workspace.getActiveFile();
                if ( file )
                {
                    await this.plugin.app.fileManager.processFrontMatter( file, fm =>
                    {
                        fm.profileName = this.profile.name;
                        fm.postId = postId;
                        fm.postType = postParams.postType;
                        if ( postParams.postType === PostTypeConst.Post )
                        {
                            fm.categories = postParams.categories;
                        }
                        if ( isFunction( updateMatterData ) )
                        {
                            updateMatterData( fm );
                        }
                    } );
                }

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
                    const imgFile    = this.plugin.app.metadataCache.getFirstLinkpathDest( img.src, fileName );
                    if ( imgFile instanceof TFile )
                    {
                        const content = await this.plugin.app.vault.readBinary( imgFile );
                        const fileType = fileTypeChecker.detectFile( content );
                        const result = await this.uploadMedia( {
                            mimeType : fileType?.mimeType ?? "application/octet-stream", fileName : imgFile.name, content : content
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

        // 모든 매치를 인덱스와 함께 수집
        interface Match
        {
            type        : string;
            content     : string;
            attributes? : string;
            index       : number;
            length      : number;
            original    : string;
        }


        const allMatches : Match[] = [];

        // 제목 태그 처리
        this.collectMatches( html, /<h([1-6])>([\s\S]*?)<\/h\1>/g, ( match ) =>
        {
            const level     = match[ 1 ];
            const content   = match[ 2 ];
            const levelAttr = level !== "2" ? ` {"level":${ level }}` : "";

            allMatches.push
            ( {
                type       : "heading", 
                content    : `<h${ level }>${ content }</h${ level }>`, 
                attributes : levelAttr, 
                index      : match.index, 
                length     : match[ 0 ].length, 
                original   : match[ 0 ]
            } );
        } );

        // 단락 태그 처리
        this.collectMatches( html, /<p>([\s\S]*?)<\/p>/g, ( match ) =>
        {
            allMatches.push
            ( {
                type     : "paragraph", 
                content  : `<p>${ match[ 1 ] }</p>`, 
                index    : match.index, 
                length   : match[ 0 ].length, 
                original : match[ 0 ]
            } );
        } );

        // 목록 태그 처리
        this.collectMatches( html, /<ul>([\s\S]*?)<\/ul>/g, ( match ) =>
        {
            allMatches.push
            ( {
                type     : "list", 
                content  : `<ul>${ match[ 1 ] }</ul>`, 
                index    : match.index, 
                length   : match[ 0 ].length, 
                original : match[ 0 ]
            } );
        } );

        // 순서 있는 목록 태그 처리
        this.collectMatches( html, /<ol>([\s\S]*?)<\/ol>/g, ( match ) =>
        {
            allMatches.push
            ( {
                type       : "list", 
                content    : `<ol>${ match[ 1 ] }</ol>`, 
                attributes : " {\"ordered\":true}", 
                index      : match.index, 
                length     : match[ 0 ].length, 
                original   : match[ 0 ]
            } );
        } );

        // 코드 블록 태그 처리
        this.collectMatches( html, /<pre>([\s\S]*?)<\/pre>/g, ( match ) =>
        {
            allMatches.push
            ( {
                type     : "code", 
                content  : `<pre class="wp-block-code"><code>${ match[ 1 ] }</code></pre>`, 
                index    : match.index, 
                length   : match[ 0 ].length, 
                original : match[ 0 ]
            } );
        } );

        // 인용구 태그 처리
        this.collectMatches( html, /<blockquote>([\s\S]*?)<\/blockquote>/g, ( match ) =>
        {
            allMatches.push
            ( {
                type     : "quote", 
                content  : `<blockquote class="wp-block-quote">${ match[ 1 ] }</blockquote>`, 
                index    : match.index, 
                length   : match[ 0 ].length, 
                original : match[ 0 ]
            } );
        } );

        // 매치가 있으면 인덱스 순으로 정렬하여 원래 순서 유지
        if ( allMatches.length > 0 )
        {
            // 인덱스 기준으로 정렬
            allMatches.sort( ( a, b ) => a.index - b.index );

            // 처리되지 않은 구간 추적
            let lastIndex = 0;
            let processedHtml = html;
            
            // 각 매치를 순서대로 처리
            for ( const match of allMatches )
            {
                // 매치 이전의 텍스트가 있으면 처리
                if ( match.index > lastIndex )
                {
                    const beforeText = html.substring( lastIndex, match.index ).trim();

                    if ( beforeText )
                    {
                        // HTML 태그를 제거하고 텍스트만 추출
                        const textContent = beforeText.replace( /<[^>]*>/g, "" ).trim();

                        if ( textContent )
                        {
                            blocks.push( this.createParagraphBlock( textContent ) );
                        }
                    }
                }
                
                // 매치된 블록 추가
                blocks.push( this.createWpBlock( match.type, match.content, match.attributes ) );
                lastIndex = match.index + match.length;
            }

            // 마지막 매치 이후의 텍스트가 있으면 처리
            if ( lastIndex < html.length )
            {
                const afterText = html.substring( lastIndex ).trim();
                
                if ( afterText )
                {
                    // HTML 태그를 제거하고 텍스트만 추출
                    const textContent = afterText.replace( /<[^>]*>/g, "" ).trim();
                    
                    if ( textContent )
                    {
                        blocks.push( this.createParagraphBlock( textContent ) );
                    }
                }
            }
        }
        else
        {
            // 매치가 없으면 전체를 단락으로 처리
            // HTML 태그를 제거하고 텍스트만 추출
            const textContent = html.replace( /<[^>]*>/g, "" ).trim();
            
            if ( textContent )
            {
                blocks.push( this.createParagraphBlock( textContent ) );
            }
        }

        return blocks;
    }

    /// 지정된 정규식 패턴과 일치하는 모든 매치를 수집합니다.
    private collectMatches( html : string, regex : RegExp, callback : ( match : RegExpExecArray ) => void ) : void
    {
        let match;
        regex.lastIndex = 0; // 정규식 인덱스 초기화

        while ( ( match = regex.exec( html ) ) !== null )
        {
            callback( match );
        }
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
